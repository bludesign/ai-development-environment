import {
  spawnExecutionProcess,
  executionEnvironment,
} from "../execution-recovery.js";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunSessionInfo } from "@ai-development-environment/agent-contract/runs";
import { findClaudeSessionFile } from "../handlers/runs.js";
import {
  claudeImportedHistory,
  claudeSubagentSnapshot,
  claudeTranscriptMetadata,
  readClaudeTranscript,
} from "./claude-import.js";

import {
  deleteSession,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  query,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  findExecutable,
  type ExecutableLookupOptions,
} from "../executable-lookup.js";

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
  type ProviderSubagentSnapshot,
  type ProviderUsage,
  type StagedAttachment,
} from "./provider.js";

const SUBAGENT_PAGE_SIZE = 500;
const MAX_SUBAGENT_MESSAGES = 10_000;
const MAX_SUBAGENT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_SUBAGENT_BYTES = 32 * 1024 * 1024;
const MAX_SUBAGENT_CACHE_BYTES = 64 * 1024 * 1024;

type SubagentHistoryCacheEntry = {
  fingerprint: string;
  messages: unknown[];
  bytes: number;
};

function claudeMessageSummary(record: Record<string, unknown>): string {
  const message = asRecord(record.message);
  const content = Array.isArray(message.content) ? message.content : [];
  return (
    content
      .map(asRecord)
      .map((block) =>
        block.type === "tool_use"
          ? String(block.name ?? "Tool call")
          : block.type === "tool_result"
            ? "Tool result"
            : block.type === "thinking" || block.type === "redacted_thinking"
              ? "Thinking"
              : String(block.type ?? "Claude message"),
      )
      .join(", ") || `Claude ${String(record.type)}`
  );
}

export function findClaudeCodeExecutable(
  options: ExecutableLookupOptions = {},
): string | undefined {
  return findExecutable("claude", {
    ...options,
    overrideVariable: "CONTROL_AGENT_CLAUDE_EXECUTABLE",
  });
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<
    (value: IteratorResult<SDKUserMessage>) => void
  > = [];
  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  push(text: string, priority?: "now" | "next"): void {
    if (this.closed) throw new Error("Claude input stream is closed");
    const value = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      priority,
    } as SDKUserMessage;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function promptWithAttachments(
  prompt: string,
  attachments: StagedAttachment[],
): string {
  if (!attachments.length) return prompt;
  return `${prompt}\n\nAttached files are staged at:\n${attachments
    .map((item) => `- ${item.filename}: ${item.path}`)
    .join("\n")}`;
}

export function questionsFromInput(value: unknown): ProviderQuestion[] {
  const questions = asRecord(value).questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((candidate, index) => {
    const question = asRecord(candidate);
    return {
      id: String(question.id ?? index),
      header: typeof question.header === "string" ? question.header : undefined,
      prompt: String(question.question ?? question.prompt ?? "Question"),
      multiSelect: Boolean(question.multiSelect ?? question.multi_select),
      allowCustom: question.allowCustom !== false,
      options: Array.isArray(question.options)
        ? question.options.map((candidate) => {
            const option = asRecord(candidate);
            return {
              label: String(option.label ?? option.value ?? "Option"),
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

export function claudeAnswers(
  toolInput: unknown,
  value: unknown,
): Record<string, string> {
  const questions = questionsFromInput(toolInput);
  const answersById = asRecord(value);
  const answersByPosition = answerArrays(value);

  return Object.fromEntries(
    questions.map((question, index) => {
      const selected = Object.hasOwn(answersById, question.id)
        ? (answerArrays([answersById[question.id]])[0] ?? [])
        : (answersByPosition[index] ?? []);
      return [question.prompt, selected.join(", ")];
    }),
  );
}

export function claudeEnvironment(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
}

export function claudeMcpServers(server: ProviderStartInput["mcpServer"]) {
  return server
    ? {
        [server.name]: {
          type: "http" as const,
          url: server.url,
          headers: server.headers,
        },
      }
    : undefined;
}

/**
 * A Claude result reports usage per real model id (`claude-sonnet-5`), each with
 * its own cache-read and cache-creation token counts and reported cost. Those
 * ids price against the cost catalog where the run's own alias (`sonnet`) does
 * not, so the breakdown is preferred; a result without one falls back to a
 * single aggregate row under the run's model.
 */
export function claudeModelUsages(
  record: Record<string, unknown>,
  fallbackModel: string,
): ProviderUsage[] {
  const toolCallCount = Number(record.num_turns ?? 0);
  const entries = Object.entries(asRecord(record.modelUsage)).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      Boolean(entry[1]) && typeof entry[1] === "object",
  );
  if (entries.length) {
    return entries.map(([model, usage]) => ({
      model,
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadInputTokens ?? 0),
      cacheWriteTokens: Number(usage.cacheCreationInputTokens ?? 0),
      estimatedCost: Number(usage.costUSD ?? 0),
      toolCallCount,
      pricingSource: "claude-agent-sdk",
    }));
  }
  const usage = asRecord(record.usage);
  return [
    {
      model: fallbackModel,
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0),
      estimatedCost: Number(record.total_cost_usd ?? 0),
      toolCallCount,
      pricingSource: "claude-agent-sdk",
    },
  ];
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly key = "CLAUDE" as const;
  readonly capabilities = {
    webSearch: true,
    questions: true,
    import: true,
    pause: true,
    steering: true,
    resume: true,
    nativeDelete: true,
  } as const;
  private catalogPromise?: Promise<ProviderCatalog>;
  private readonly hydrationCache = new Map<
    string,
    { lastModified: string; history: Partial<ProviderImportedRun> }
  >();
  private readonly subagentHistoryCache = new Map<
    string,
    SubagentHistoryCacheEntry
  >();
  private subagentHistoryCacheBytes = 0;

  private cacheSubagentHistory(
    key: string,
    entry?: SubagentHistoryCacheEntry,
  ): void {
    const previous = this.subagentHistoryCache.get(key);
    if (previous) this.subagentHistoryCacheBytes -= previous.bytes;
    this.subagentHistoryCache.delete(key);
    if (entry) {
      this.subagentHistoryCache.set(key, entry);
      this.subagentHistoryCacheBytes += entry.bytes;
    }
    while (this.subagentHistoryCacheBytes > MAX_SUBAGENT_CACHE_BYTES) {
      const oldest = this.subagentHistoryCache.keys().next().value;
      if (oldest === undefined) break;
      this.subagentHistoryCacheBytes -=
        this.subagentHistoryCache.get(oldest)!.bytes;
      this.subagentHistoryCache.delete(oldest);
    }
  }

  catalog(): Promise<ProviderCatalog> {
    this.catalogPromise ??= (async () => {
      const messages = new MessageQueue();
      const pathToClaudeCodeExecutable = findClaudeCodeExecutable();
      const instance = query({
        prompt: messages,
        options: {
          ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
          env: claudeEnvironment(),
          permissionMode: "plan",
        },
      });
      try {
        const models = await instance.supportedModels();
        return {
          models: models.map((model) => ({
            id: model.value,
            label: model.displayName,
            efforts: model.supportsEffort
              ? ["auto", "low", "medium", "high", "xhigh", "max"]
              : ["auto"],
          })),
        };
      } finally {
        messages.close();
        await instance.interrupt().catch(() => undefined);
      }
    })().catch((error) => {
      this.catalogPromise = undefined;
      throw error;
    });
    return this.catalogPromise;
  }

  async start(
    input: ProviderStartInput,
    callbacks: ProviderCallbacks,
  ): Promise<ProviderHandle> {
    const messages = new MessageQueue();
    const pendingQuestions = new Map<
      string,
      { input: Record<string, unknown>; resolve: (value: unknown) => void }
    >();
    let activeQuery: Query | null = null;
    let stopReason: "PAUSED" | "CANCELLED" | null = null;
    let nativeId: string | undefined;

    messages.push(promptWithAttachments(input.prompt, input.attachments));
    const effort = ["low", "medium", "high", "xhigh", "max"].includes(
      input.run.effort ?? "",
    )
      ? (input.run.effort as "low" | "medium" | "high" | "xhigh" | "max")
      : undefined;
    const pathToClaudeCodeExecutable = findClaudeCodeExecutable();
    activeQuery = query({
      prompt: messages,
      options: {
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
        cwd: input.run.worktree!.folder,
        ...(input.textOnly
          ? {
              tools: [],
              mcpServers: {},
              strictMcpConfig: true,
              settingSources: [],
              persistSession: false,
              systemPrompt:
                "Generate text only. Return only one valid Git branch name. Do not ask questions.",
            }
          : {}),
        ...(input.run.model !== "default" ? { model: input.run.model } : {}),
        ...(effort ? { effort } : {}),
        ...(input.resumeNativeId
          ? { resume: input.resumeNativeId, forkSession: input.fork !== false }
          : {}),
        permissionMode:
          input.run.kind === "PLAN" ? "plan" : "bypassPermissions",
        allowDangerouslySkipPermissions: input.run.kind === "SESSION",
        includePartialMessages: true,
        forwardSubagentText: true,
        env: { ...claudeEnvironment(), ...executionEnvironment() },
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) =>
          spawnExecutionProcess(command, args, {
            cwd,
            env,
            signal,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        disallowedTools: input.run.webSearchEnabled ? [] : ["WebSearch"],
        ...(input.mcpServer && !input.textOnly
          ? { mcpServers: claudeMcpServers(input.mcpServer) }
          : {}),
        canUseTool: async (toolName, toolInput, options) => {
          if (input.textOnly)
            return {
              behavior: "deny",
              message: "Tools are disabled for branch naming",
            };
          if (toolName !== "AskUserQuestion") {
            return { behavior: "allow", updatedInput: toolInput };
          }
          const requestId = options.toolUseID || randomUUID();
          const questions = questionsFromInput(toolInput);
          await callbacks.onQuestion(requestId, questions);
          const answers = await new Promise<unknown>((resolve) => {
            pendingQuestions.set(requestId, { input: toolInput, resolve });
          });
          return {
            behavior: "allow",
            updatedInput: {
              ...toolInput,
              answers: claudeAnswers(toolInput, answers),
            },
          };
        },
      },
    });

    const completion = (async (): Promise<ProviderCompletion> => {
      let finalOutput = "";
      try {
        for await (const message of activeQuery!) {
          const record = asRecord(message);
          const childMessage =
            typeof record.agent_id === "string" ||
            typeof record.parent_tool_use_id === "string";
          const sessionId =
            typeof record.session_id === "string"
              ? record.session_id
              : undefined;
          if (sessionId && sessionId !== nativeId && !childMessage) {
            nativeId = sessionId;
            const version =
              record.subtype === "init" &&
              typeof record.claude_code_version === "string"
                ? record.claude_code_version
                : undefined;
            const path = await findClaudeSessionFile(
              sessionId,
              homedir(),
              process.env.CLAUDE_CONFIG_DIR,
            ).catch(() => null);
            await callbacks.onNativeId(sessionId, version, {
              workingDirectory:
                typeof record.cwd === "string" && record.cwd
                  ? record.cwd
                  : input.run.worktree!.folder,
              ...(path ? { nativeTranscriptPath: path } : {}),
            });
          }
          const messageText = firstString(
            record.message ?? record.result ?? record.summary,
          );
          const type = String(record.type ?? "message").toUpperCase();
          if (
            messageText ||
            record.type === "assistant" ||
            record.type === "user"
          ) {
            await callbacks.onEvent({
              type: type === "ASSISTANT" ? "ASSISTANT" : type,
              summary: (messageText || claudeMessageSummary(record)).slice(
                0,
                2_000,
              ),
              detailMarkdown: messageText || undefined,
              raw: message,
            });
          } else if (record.type === "system" && record.subtype) {
            await callbacks.onEvent({
              type: "SYSTEM",
              summary: `Claude ${String(record.subtype).replaceAll("_", " ")}`,
              raw: message,
            });
          }
          if (record.type === "result" && !childMessage) {
            finalOutput =
              typeof record.result === "string" ? record.result : finalOutput;
            for (const usage of claudeModelUsages(record, input.run.model)) {
              await callbacks.onUsage(usage);
            }
            if (record.is_error) {
              const errors = Array.isArray(record.errors)
                ? record.errors.map(String).join("; ")
                : "Claude execution failed";
              return { status: "FAILED", finalOutput, error: errors };
            }
            messages.close();
            return { status: "COMPLETED", finalOutput };
          }
        }
        return stopReason
          ? { status: stopReason, finalOutput }
          : { status: "COMPLETED", finalOutput };
      } catch (error) {
        return stopReason
          ? { status: stopReason, finalOutput }
          : {
              status: "FAILED",
              finalOutput,
              error: error instanceof Error ? error.message : String(error),
            };
      } finally {
        messages.close();
        if (executionEnvironment().AIDE_EXECUTION_MARKER) activeQuery?.close();
      }
    })();

    return {
      get nativeId() {
        return nativeId;
      },
      completion,
      async interrupt(reason) {
        stopReason = reason;
        // Settle any AskUserQuestion callback still awaiting an answer so its
        // canUseTool promise resolves instead of leaking while the query is
        // torn down.
        for (const pending of pendingQuestions.values()) pending.resolve({});
        pendingQuestions.clear();
        await activeQuery?.interrupt();
      },
      async steer(prompt, attachments) {
        if (messages.isClosed) throw new Error("Claude run already completed");
        messages.push(promptWithAttachments(prompt, attachments), "now");
      },
      async answer(requestId, answers) {
        const pending = pendingQuestions.get(requestId);
        if (!pending) throw new Error("Claude question is no longer pending");
        pendingQuestions.delete(requestId);
        pending.resolve(answers);
      },
    };
  }

  delete(nativeId: string, cwd: string): Promise<void> {
    return deleteSession(nativeId, { dir: cwd });
  }

  private async discoverSubagents(
    sessionId: string,
    folder: string,
    history: Partial<ProviderImportedRun>,
    transcriptPath?: string | null,
  ): Promise<ProviderSubagentSnapshot[] | undefined> {
    let ids: string[];
    try {
      ids = await listSubagents(sessionId, { dir: folder });
    } catch {
      // Omit a failed listing so previously imported children remain available.
      return undefined;
    }
    const children: Array<{
      nativeId: string;
      messages: unknown[];
      transcriptStatus: ProviderSubagentSnapshot["transcriptStatus"];
      transcriptError?: string;
    }> = [];
    let sessionBytes = 0;
    for (const nativeId of [...new Set(ids)]) {
      const cacheKey = JSON.stringify([sessionId, folder, nativeId]);
      let fingerprint: string | undefined;
      if (transcriptPath && !/[/\\]/.test(nativeId)) {
        try {
          // The SDK documents this child location relative to its parent JSONL.
          const childPath = join(
            dirname(transcriptPath),
            sessionId,
            "subagents",
            `agent-${nativeId}`,
          );
          const file = await stat(`${childPath}.jsonl`);
          const metadata = await stat(`${childPath}.meta.json`).catch(
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return null;
              throw error;
            },
          );
          if (file.isFile())
            fingerprint = `${file.size}:${file.mtimeMs}:${metadata?.size ?? "missing"}:${metadata?.mtimeMs ?? "missing"}`;
        } catch {
          // Without a trustworthy file fingerprint, read through the SDK again.
        }
      }
      const cached = this.subagentHistoryCache.get(cacheKey);
      if (
        cached &&
        cached.fingerprint === fingerprint &&
        sessionBytes + cached.bytes <= MAX_SESSION_SUBAGENT_BYTES
      ) {
        this.cacheSubagentHistory(cacheKey, cached);
        children.push({
          nativeId,
          messages: cached.messages,
          transcriptStatus: "AVAILABLE",
        });
        sessionBytes += cached.bytes;
        continue;
      }
      this.cacheSubagentHistory(cacheKey);
      const messages: unknown[] = [];
      let transcriptStatus: ProviderSubagentSnapshot["transcriptStatus"] =
        "AVAILABLE";
      let transcriptError: string | undefined;
      let offset = 0;
      let childBytes = 0;
      try {
        while (offset < MAX_SUBAGENT_MESSAGES) {
          if (sessionBytes >= MAX_SESSION_SUBAGENT_BYTES) {
            transcriptStatus = messages.length ? "PARTIAL" : "UNAVAILABLE";
            transcriptError = "Session subagent transcript size limit reached.";
            break;
          }
          const limit = Math.min(
            SUBAGENT_PAGE_SIZE,
            MAX_SUBAGENT_MESSAGES - offset,
          );
          const page = await getSubagentMessages(sessionId, nativeId, {
            dir: folder,
            limit,
            offset,
          });
          for (const message of page) {
            const bytes = Buffer.byteLength(JSON.stringify(message));
            if (
              childBytes + bytes > MAX_SUBAGENT_BYTES ||
              sessionBytes + bytes > MAX_SESSION_SUBAGENT_BYTES
            ) {
              transcriptStatus = messages.length ? "PARTIAL" : "UNAVAILABLE";
              transcriptError = "Subagent transcript size limit reached.";
              break;
            }
            messages.push(message);
            childBytes += bytes;
            sessionBytes += bytes;
          }
          if (transcriptError || page.length < limit) break;
          offset += page.length;
          if (offset >= MAX_SUBAGENT_MESSAGES) {
            transcriptStatus = "PARTIAL";
            transcriptError = "Subagent transcript message limit reached.";
          }
        }
        if (!messages.length && !transcriptError) {
          transcriptStatus = "UNAVAILABLE";
          transcriptError = "Subagent transcript was not found.";
        }
      } catch (error) {
        transcriptStatus = messages.length ? "PARTIAL" : "UNAVAILABLE";
        transcriptError =
          error instanceof Error
            ? error.message
            : "Subagent transcript failed.";
      }
      children.push({ nativeId, messages, transcriptStatus, transcriptError });
      if (transcriptStatus === "AVAILABLE" && fingerprint) {
        this.cacheSubagentHistory(cacheKey, {
          fingerprint,
          messages,
          bytes: childBytes,
        });
      }
    }
    const metadata = [
      ...(history.events ?? []),
      ...children.flatMap((child) => child.messages),
    ];
    return children.map((child) =>
      claudeSubagentSnapshot(child.nativeId, child.messages, metadata, {
        transcriptStatus: child.transcriptStatus,
        transcriptError: child.transcriptError,
      }),
    );
  }

  async discover(
    worktrees: ProviderImportWorktree[],
  ): Promise<ProviderImportedRun[]> {
    const results: ProviderImportedRun[] = [];
    for (const worktree of worktrees) {
      const sessions = await listSessions({
        dir: worktree.folder,
        includeWorktrees: false,
      });
      for (const session of sessions) {
        const lastModifiedKey = `${session.lastModified ?? ""}:${session.fileSize ?? ""}`;
        const cached = this.hydrationCache.get(session.sessionId);
        let history: Partial<ProviderImportedRun> = {};
        const path = await findClaudeSessionFile(
          session.sessionId,
          homedir(),
          process.env.CLAUDE_CONFIG_DIR,
        ).catch(() => null);
        const sessionInfo: RunSessionInfo = {
          workingDirectory: session.cwd || worktree.folder,
          ...(path ? { nativeTranscriptPath: path } : {}),
        };
        if (cached && cached.lastModified === lastModifiedKey) {
          history = cached.history;
        } else {
          let transcript: unknown[] = [];
          try {
            if (path) transcript = await readClaudeTranscript(path);
            history = claudeTranscriptMetadata(transcript);
          } catch {
            // SDK messages can still provide activity, model, and token usage.
          }
          try {
            const messages = await getSessionMessages(session.sessionId, {
              dir: worktree.folder,
              includeSystemMessages: true,
            });
            // An empty result can mean the SDK could not locate the transcript.
            if (messages.length) {
              history = claudeImportedHistory(messages, transcript);
              if (history.model && history.usage) {
                this.hydrationCache.set(session.sessionId, {
                  lastModified: lastModifiedKey,
                  history,
                });
              }
            }
          } catch {
            // Omit activity snapshots on failure so previous imports remain intact.
          }
        }
        // Child transcripts grow independently of the parent's list metadata.
        const subagents = await this.discoverSubagents(
          session.sessionId,
          worktree.folder,
          history,
          sessionInfo.nativeTranscriptPath,
        );
        results.push({
          nativeId: session.sessionId,
          worktreeId: worktree.id,
          ...history,
          status: "COMPLETED",
          prompt: history.prompt || session.firstPrompt || session.summary,
          branch: session.gitBranch || worktree.branch || undefined,
          createdAt: session.createdAt
            ? new Date(session.createdAt).toISOString()
            : undefined,
          updatedAt: new Date(session.lastModified).toISOString(),
          rawMetadata: session,
          sessionInfo,
          ...(subagents === undefined ? {} : { subagents }),
        });
      }
    }
    return results;
  }
}
