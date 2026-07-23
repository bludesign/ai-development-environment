import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import {
  answerArrays,
  asRecord,
  firstString,
  type ProviderAdapter,
  type ProviderCallbacks,
  type ProviderCatalog,
  type ProviderCompletion,
  type ProviderHandle,
  type ProviderImportedRun,
  type ProviderImportWorktree,
  type ProviderQuestion,
  type ProviderStartInput,
  type StagedAttachment,
} from "./provider.js";

type JsonRpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

export const SUPPORTED_CODEX_APP_SERVER_MINORS = ["0.144", "0.145"] as const;
const execFileAsync = promisify(execFile);

export function codexAppServerArgs(modelCatalogPath: string): string[] {
  return [
    "app-server",
    "-c",
    `model_catalog_json=${JSON.stringify(modelCatalogPath)}`,
    "--listen",
    "stdio://",
  ];
}

export function codexVersionFromUserAgent(userAgent: string): string | null {
  return userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null;
}

export function supportedCodexVersion(version: string | null): boolean {
  return Boolean(
    version &&
    SUPPORTED_CODEX_APP_SERVER_MINORS.some((minor) =>
      version.startsWith(`${minor}.`),
    ),
  );
}

class CodexAppServer {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly threadListeners = new Map<
    string,
    Set<(message: JsonRpcMessage) => void>
  >();
  private initialized?: Promise<void>;
  private modelCatalogDirectory?: string;

  private ensureStarted(): Promise<void> {
    this.initialized ??= this.start();
    return this.initialized;
  }

  private async start(): Promise<void> {
    const modelCatalogPath = await this.createBundledModelCatalog();
    const modelCatalogDirectory = this.modelCatalogDirectory;
    const child = spawn("codex", codexAppServerArgs(modelCatalogPath), {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;
    child.on("exit", (code, signal) => {
      const error = new Error(
        `Codex app-server exited (${code ?? signal ?? "unknown"})`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.process = undefined;
      this.initialized = undefined;
      void this.removeBundledModelCatalog(modelCatalogDirectory);
    });
    child.on("error", () => {
      void this.removeBundledModelCatalog(modelCatalogDirectory);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error(`codex app-server: ${text}`);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const initialized = asRecord(
      await this.requestDirect("initialize", {
        clientInfo: {
          name: "ai-development-environment-control-agent",
          title: "AI Development Environment",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      }),
    );
    const userAgent = String(initialized.userAgent ?? "");
    const version = codexVersionFromUserAgent(userAgent);
    if (!supportedCodexVersion(version)) {
      child.kill("SIGTERM");
      throw new Error(
        `Unsupported Codex app-server ${version ?? "version"}; expected ${SUPPORTED_CODEX_APP_SERVER_MINORS.map((minor) => `${minor}.x`).join(" or ")}`,
      );
    }
    this.notify("initialized", {});
    await this.requestDirect("model/list", {
      cursor: null,
      limit: 1,
      includeHidden: false,
    });
    const modes = asRecord(
      await this.requestDirect("collaborationMode/list", {}),
    );
    const supportsPlan =
      Array.isArray(modes.data) &&
      modes.data.some((entry) => {
        const mode = asRecord(entry);
        return mode.mode === "plan" || mode.name === "plan";
      });
    if (!supportsPlan) {
      child.kill("SIGTERM");
      throw new Error(
        "Codex app-server does not expose plan collaboration mode",
      );
    }
  }

  private async createBundledModelCatalog(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "aide-codex-models-"));
    try {
      // App-server expects a rich remote catalog that OpenAI-compatible model
      // proxies do not expose. A startup catalog avoids that incompatible
      // refresh without changing the configured provider used for inference.
      const { stdout } = await execFileAsync(
        "codex",
        ["debug", "models", "--bundled"],
        {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const catalogPath = join(directory, "models.json");
      await writeFile(catalogPath, stdout, "utf8");
      this.modelCatalogDirectory = directory;
      return catalogPath;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async removeBundledModelCatalog(
    directory = this.modelCatalogDirectory,
  ): Promise<void> {
    if (!directory) return;
    if (this.modelCatalogDirectory === directory) {
      this.modelCatalogDirectory = undefined;
    }
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      console.error(`Ignoring malformed Codex app-server output: ${line}`);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(message.error.message || "Codex request failed"),
        );
      else pending.resolve(message.result);
      return;
    }
    const params = asRecord(message.params);
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    if (threadId) {
      for (const listener of this.threadListeners.get(threadId) ?? [])
        listener(message);
    }
  }

  private write(message: JsonRpcMessage): void {
    if (!this.process?.stdin.writable)
      throw new Error("Codex app-server is unavailable");
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
    );
  }

  private requestDirect(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureStarted();
    return this.requestDirect(method, params);
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  listen(
    threadId: string,
    listener: (message: JsonRpcMessage) => void,
  ): () => void {
    const listeners = this.threadListeners.get(threadId) ?? new Set();
    listeners.add(listener);
    this.threadListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.threadListeners.delete(threadId);
    };
  }

  async close(): Promise<void> {
    this.process?.kill("SIGTERM");
    this.process = undefined;
    this.initialized = undefined;
    await this.removeBundledModelCatalog();
  }
}

function textInput(prompt: string, attachments: StagedAttachment[]) {
  const fileNotes = attachments
    .filter((item) => !item.contentType.startsWith("image/"))
    .map((item) => `- ${item.filename}: ${item.path}`);
  return [
    {
      type: "text",
      text: fileNotes.length
        ? `${prompt}\n\nAttached files are staged at:\n${fileNotes.join("\n")}`
        : prompt,
    },
    ...attachments
      .filter((item) => item.contentType.startsWith("image/"))
      .map((item) => ({ type: "localImage", path: item.path })),
  ];
}

export function codexQuestions(value: unknown): ProviderQuestion[] {
  const candidates = asRecord(value).questions;
  if (!Array.isArray(candidates)) return [];
  return candidates.map((candidate, index) => {
    const question = asRecord(candidate);
    return {
      id: String(question.id ?? index),
      header: typeof question.header === "string" ? question.header : undefined,
      prompt: String(question.question ?? "Question"),
      allowCustom: Boolean(question.isOther),
      options: Array.isArray(question.options)
        ? question.options.map((candidate) => {
            const option = asRecord(candidate);
            return {
              label: String(option.label ?? "Option"),
              description:
                typeof option.description === "string"
                  ? option.description
                  : undefined,
            };
          })
        : [],
    };
  });
}

function answerMap(questions: ProviderQuestion[], value: unknown) {
  const arrays = answerArrays(value);
  return Object.fromEntries(
    questions.map((question, index) => [
      question.id,
      { answers: arrays[index] ?? [] },
    ]),
  );
}

export class CodexAdapter implements ProviderAdapter {
  readonly key = "CODEX" as const;
  readonly capabilities = {
    webSearch: true,
    questions: true,
    import: true,
    pause: true,
    steering: true,
    resume: true,
    nativeDelete: true,
  } as const;
  private readonly server = new CodexAppServer();

  async catalog(): Promise<ProviderCatalog> {
    const models: ProviderCatalog["models"] = [];
    let cursor: string | null = null;
    do {
      const page = asRecord(
        await this.server.request("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        }),
      );
      for (const value of Array.isArray(page.data) ? page.data : []) {
        const model = asRecord(value);
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
              .map((entry) => String(asRecord(entry).reasoningEffort ?? ""))
              .filter(Boolean)
          : [];
        models.push({
          id: String(model.model ?? model.id),
          label: String(model.displayName ?? model.model ?? model.id),
          efforts: ["auto", ...efforts.filter((effort) => effort !== "auto")],
        });
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    return { models };
  }

  async start(
    input: ProviderStartInput,
    callbacks: ProviderCallbacks,
  ): Promise<ProviderHandle> {
    const cwd = input.run.worktree!.folder;
    const sandbox =
      input.run.kind === "PLAN" ? "read-only" : "danger-full-access";
    const threadResult = asRecord(
      input.resumeNativeId
        ? await this.server.request(
            input.fork === false ? "thread/resume" : "thread/fork",
            {
              threadId: input.resumeNativeId,
              cwd,
              model: input.run.model === "default" ? null : input.run.model,
              approvalPolicy: "never",
              sandbox,
              config: {
                web_search: input.run.webSearchEnabled ? "live" : "disabled",
              },
            },
          )
        : await this.server.request("thread/start", {
            cwd,
            model: input.run.model === "default" ? null : input.run.model,
            approvalPolicy: "never",
            sandbox,
            config: {
              web_search: input.run.webSearchEnabled ? "live" : "disabled",
            },
            ephemeral: false,
            experimentalRawEvents: false,
          }),
    );
    const thread = asRecord(threadResult.thread);
    const nativeId = String(thread.id);
    if (!nativeId || nativeId === "undefined")
      throw new Error("Codex did not return a thread ID");
    await callbacks.onNativeId(
      nativeId,
      typeof thread.cliVersion === "string" ? thread.cliVersion : undefined,
    );

    let turnId = "";
    let stopReason: "PAUSED" | "CANCELLED" | null = null;
    let finalOutput = "";
    const pendingQuestions = new Map<
      string,
      { rpcId: string | number; questions: ProviderQuestion[] }
    >();
    let resolveCompletion!: (value: ProviderCompletion) => void;
    const completion = new Promise<ProviderCompletion>((resolve) => {
      resolveCompletion = resolve;
    });

    const unsubscribe = this.server.listen(nativeId, (message) => {
      void (async () => {
        const params = asRecord(message.params);
        if (
          message.method === "item/tool/requestUserInput" &&
          message.id !== undefined
        ) {
          const questions = codexQuestions(params);
          const requestId = String(message.id);
          pendingQuestions.set(requestId, { rpcId: message.id, questions });
          await callbacks.onQuestion(requestId, questions);
          return;
        }
        const text = firstString(
          params.delta ??
            params.message ??
            params.item ??
            params.plan ??
            params.error,
        );
        if (
          message.method === "item/agentMessage/delta" &&
          typeof params.delta === "string"
        ) {
          finalOutput += params.delta;
        }
        if (
          message.method === "item/plan/delta" &&
          typeof params.delta === "string"
        ) {
          finalOutput += params.delta;
        }
        if (message.method === "thread/tokenUsage/updated") {
          const usage = asRecord(params.tokenUsage ?? params.usage);
          const total = asRecord(usage.total ?? usage);
          await callbacks.onUsage({
            model: input.run.model,
            inputTokens: Number(total.inputTokens ?? total.input_tokens ?? 0),
            outputTokens: Number(
              total.outputTokens ?? total.output_tokens ?? 0,
            ),
            reasoningTokens: Number(
              total.reasoningTokens ?? total.reasoning_tokens ?? 0,
            ),
            cacheReadTokens: Number(
              total.cachedInputTokens ?? total.cache_read_tokens ?? 0,
            ),
            cacheWriteTokens: Number(
              total.cacheWriteTokens ?? total.cache_write_tokens ?? 0,
            ),
            pricingSource: "codex-app-server",
          });
        }
        if (message.method) {
          await callbacks.onEvent({
            type: message.method.toUpperCase().replaceAll("/", "_"),
            summary: (text || message.method).slice(0, 2_000),
            detailMarkdown: text,
            raw: message,
          });
        }
        if (message.method === "turn/completed") {
          unsubscribe();
          const turn = asRecord(params.turn);
          const status = String(turn.status ?? "completed").toLowerCase();
          if (stopReason)
            resolveCompletion({ status: stopReason, finalOutput });
          else if (status.includes("fail")) {
            resolveCompletion({
              status: "FAILED",
              finalOutput,
              error: firstString(turn.error) || "Codex turn failed",
            });
          } else resolveCompletion({ status: "COMPLETED", finalOutput });
        }
      })().catch((error) => {
        unsubscribe();
        resolveCompletion({
          status: "FAILED",
          finalOutput,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    const resolvedModel =
      typeof threadResult.model === "string"
        ? threadResult.model
        : input.run.model;
    const turnResult = asRecord(
      await this.server.request("turn/start", {
        threadId: nativeId,
        input: textInput(input.prompt, input.attachments),
        model: input.run.model === "default" ? null : input.run.model,
        effort:
          input.run.effort && input.run.effort !== "auto"
            ? input.run.effort
            : null,
        approvalPolicy: "never",
        ...(input.run.kind === "PLAN"
          ? {
              collaborationMode: {
                mode: "plan",
                settings: {
                  model: resolvedModel,
                  reasoning_effort:
                    input.run.effort && input.run.effort !== "auto"
                      ? input.run.effort
                      : null,
                  developer_instructions: null,
                },
              },
            }
          : {}),
      }),
    );
    turnId = String(asRecord(turnResult.turn).id);
    const server = this.server;

    return {
      nativeId,
      completion,
      async interrupt(reason) {
        stopReason = reason;
        await server.request("turn/interrupt", { threadId: nativeId, turnId });
      },
      async steer(prompt, attachments) {
        await server.request("turn/steer", {
          threadId: nativeId,
          expectedTurnId: turnId,
          input: textInput(prompt, attachments),
        });
      },
      async answer(requestId, answers) {
        const pending = pendingQuestions.get(requestId);
        if (!pending) throw new Error("Codex question is no longer pending");
        pendingQuestions.delete(requestId);
        server.respond(pending.rpcId, {
          answers: answerMap(pending.questions, answers),
        });
      },
    };
  }

  async delete(nativeId: string): Promise<void> {
    await this.server.request("thread/delete", { threadId: nativeId });
  }

  async discover(
    worktrees: ProviderImportWorktree[],
  ): Promise<ProviderImportedRun[]> {
    const results: ProviderImportedRun[] = [];
    for (const worktree of worktrees) {
      for (const archived of [false, true]) {
        let cursor: string | null = null;
        do {
          const page = asRecord(
            await this.server.request("thread/list", {
              cwd: worktree.folder,
              archived,
              cursor,
              limit: 100,
              sortDirection: "asc",
            }),
          );
          const threads = Array.isArray(page.data) ? page.data : [];
          for (const value of threads) {
            const thread = asRecord(value);
            let finalOutput: string | undefined;
            let kind: "PLAN" | "SESSION" = "SESSION";
            try {
              const detail = asRecord(
                await this.server.request("thread/read", {
                  threadId: String(thread.id),
                  includeTurns: true,
                }),
              );
              const hydrated = asRecord(detail.thread);
              const serialized = JSON.stringify(hydrated.turns ?? []);
              if (serialized.includes('"type":"plan"')) kind = "PLAN";
              finalOutput = firstString(
                Array.isArray(hydrated.turns)
                  ? [...hydrated.turns].reverse()
                  : [],
              );
            } catch {
              // Keep list metadata when a history cannot be fully hydrated.
            }
            results.push({
              nativeId: String(thread.id),
              worktreeId: worktree.id,
              kind,
              status: String(
                asRecord(thread.status).type ?? thread.status ?? "COMPLETED",
              ).toUpperCase(),
              archived,
              prompt: String(
                thread.preview ?? thread.name ?? "Imported Codex thread",
              ),
              finalOutput,
              branch:
                firstString(asRecord(thread.gitInfo).branch) ||
                worktree.branch ||
                undefined,
              createdAt: thread.createdAt
                ? new Date(Number(thread.createdAt) * 1_000).toISOString()
                : undefined,
              updatedAt: thread.updatedAt
                ? new Date(Number(thread.updatedAt) * 1_000).toISOString()
                : undefined,
              rawMetadata: thread,
            });
          }
          cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
        } while (cursor);
      }
    }
    return results;
  }

  close(): Promise<void> {
    return this.server.close();
  }
}
