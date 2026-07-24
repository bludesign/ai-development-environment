import { randomUUID } from "node:crypto";

import {
  deleteSession,
  getSessionMessages,
  listSessions,
  query,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

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
  type ProviderUsage,
  type StagedAttachment,
} from "./provider.js";

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
    { lastModified: string; kind: "PLAN" | "SESSION"; finalOutput?: string }
  >();

  catalog(): Promise<ProviderCatalog> {
    this.catalogPromise ??= (async () => {
      const messages = new MessageQueue();
      const instance = query({
        prompt: messages,
        options: {
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
    activeQuery = query({
      prompt: messages,
      options: {
        cwd: input.run.worktree!.folder,
        ...(input.run.model !== "default" ? { model: input.run.model } : {}),
        ...(effort ? { effort } : {}),
        ...(input.resumeNativeId
          ? { resume: input.resumeNativeId, forkSession: input.fork !== false }
          : {}),
        permissionMode:
          input.run.kind === "PLAN" ? "plan" : "bypassPermissions",
        allowDangerouslySkipPermissions: input.run.kind === "SESSION",
        includePartialMessages: true,
        env: claudeEnvironment(),
        disallowedTools: input.run.webSearchEnabled ? [] : ["WebSearch"],
        canUseTool: async (toolName, toolInput, options) => {
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
          const sessionId =
            typeof record.session_id === "string"
              ? record.session_id
              : undefined;
          if (sessionId && sessionId !== nativeId) {
            nativeId = sessionId;
            const version =
              record.subtype === "init" &&
              typeof record.claude_code_version === "string"
                ? record.claude_code_version
                : undefined;
            await callbacks.onNativeId(sessionId, version);
          }
          const messageText = firstString(
            record.message ?? record.result ?? record.summary,
          );
          const type = String(record.type ?? "message").toUpperCase();
          if (messageText) {
            await callbacks.onEvent({
              type: type === "ASSISTANT" ? "ASSISTANT" : type,
              summary: messageText.slice(0, 2_000),
              detailMarkdown: messageText,
              raw: message,
            });
          } else if (record.type === "system" && record.subtype) {
            await callbacks.onEvent({
              type: "SYSTEM",
              summary: `Claude ${String(record.subtype).replaceAll("_", " ")}`,
              raw: message,
            });
          }
          if (record.type === "result") {
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

  async discover(
    worktrees: ProviderImportWorktree[],
  ): Promise<ProviderImportedRun[]> {
    const results: ProviderImportedRun[] = [];
    for (const worktree of worktrees) {
      const sessions = await listSessions({ dir: worktree.folder, limit: 500 });
      for (const session of sessions) {
        const lastModifiedKey = String(session.lastModified ?? "");
        const cached = this.hydrationCache.get(session.sessionId);
        let kind: "PLAN" | "SESSION" = "SESSION";
        let finalOutput: string | undefined;
        if (cached && cached.lastModified === lastModifiedKey) {
          kind = cached.kind;
          finalOutput = cached.finalOutput;
        } else {
          try {
            const history = await getSessionMessages(session.sessionId, {
              dir: worktree.folder,
              limit: 500,
            });
            const serialized = JSON.stringify(history);
            if (serialized.includes('"permissionMode":"plan"')) kind = "PLAN";
            finalOutput = firstString([...history].reverse());
            this.hydrationCache.set(session.sessionId, {
              lastModified: lastModifiedKey,
              kind,
              finalOutput,
            });
          } catch {
            // Metadata is still useful when an older history cannot be hydrated.
          }
        }
        results.push({
          nativeId: session.sessionId,
          worktreeId: worktree.id,
          kind,
          status: "COMPLETED",
          prompt: session.firstPrompt || session.summary,
          finalOutput: finalOutput || session.summary,
          branch: session.gitBranch || worktree.branch || undefined,
          createdAt: session.createdAt
            ? new Date(session.createdAt).toISOString()
            : undefined,
          updatedAt: new Date(session.lastModified).toISOString(),
          rawMetadata: session,
        });
      }
    }
    return results;
  }
}
