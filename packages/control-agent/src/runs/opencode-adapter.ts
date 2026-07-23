import { pathToFileURL } from "node:url";

import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk/v2";

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

const QUESTION_RECONCILIATION_INTERVAL_MS = 1_000;

type OpenCodeQuestionSurface = "LEGACY" | "V2";

type OpenCodeQuestionRequest = {
  id: string;
  sessionId?: string;
  surface: OpenCodeQuestionSurface;
  questions: ProviderQuestion[];
};

function resultData(value: unknown): unknown {
  const record = asRecord(value);
  return "data" in record ? record.data : value;
}

function model(
  value: string,
): { providerID: string; modelID: string } | undefined {
  if (!value || value === "default") return undefined;
  const separator = value.indexOf("/");
  return separator > 0
    ? {
        providerID: value.slice(0, separator),
        modelID: value.slice(separator + 1),
      }
    : undefined;
}

function eventSessionId(value: unknown): string | undefined {
  const event = asRecord(value);
  const payload = asRecord(event.payload);
  const properties = asRecord(payload.properties ?? event.properties);
  const data = asRecord(payload.data ?? event.data ?? properties.data);
  const info = asRecord(properties.info ?? data.info);
  for (const candidate of [
    properties.sessionID,
    data.sessionID,
    info.sessionID,
  ]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

export function opencodeResponseText(value: unknown): string {
  const response = asRecord(value);
  const parts = Array.isArray(response.parts) ? response.parts : [];
  const text = parts
    .map((part) => {
      const record = asRecord(part);
      return record.type === "text" && typeof record.text === "string"
        ? record.text.trim()
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return text || firstString(response.structured ?? response.output) || "";
}

export function opencodeEventText(value: unknown): string | undefined {
  const event = asRecord(value);
  const payload = asRecord(event.payload);
  const body = asRecord(
    payload.properties ?? payload.data ?? event.properties ?? event.data,
  );
  return (
    opencodeResponseText(body) ||
    firstString(body.part ?? body.message ?? body.info ?? body)
  );
}

export function opencodeQuestions(
  value: unknown,
): { id: string; questions: ProviderQuestion[] } | null {
  const request = opencodeQuestionRequest(value);
  return request ? { id: request.id, questions: request.questions } : null;
}

function opencodeQuestionRequest(
  value: unknown,
  fallbackSurface?: OpenCodeQuestionSurface,
): OpenCodeQuestionRequest | null {
  const event = asRecord(value);
  const payload = asRecord(event.payload);
  const type = String(payload.type ?? event.type ?? "");
  if (type && type !== "question.asked" && type !== "question.v2.asked")
    return null;
  const properties = asRecord(payload.properties ?? event.properties);
  const request = type
    ? asRecord(
        properties.request ??
          properties.data ??
          payload.data ??
          event.data ??
          properties,
      )
    : event;
  const candidates = request.questions;
  if (!Array.isArray(candidates)) return null;
  return {
    id: String(request.id ?? properties.id ?? "question"),
    sessionId:
      typeof request.sessionID === "string"
        ? request.sessionID
        : typeof properties.sessionID === "string"
          ? properties.sessionID
          : undefined,
    surface:
      type === "question.v2.asked" ? "V2" : (fallbackSurface ?? "LEGACY"),
    questions: candidates.map((candidate, index) => {
      const question = asRecord(candidate);
      return {
        id: String(question.id ?? index),
        header:
          typeof question.header === "string" ? question.header : undefined,
        prompt: String(question.question ?? question.prompt ?? "Question"),
        multiSelect: Boolean(question.multiple ?? question.multiSelect),
        allowCustom: question.custom !== false,
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
    }),
  };
}

function opencodeQuestionResolution(value: unknown): string | undefined {
  const event = asRecord(value);
  const payload = asRecord(event.payload);
  const type = String(payload.type ?? event.type ?? "");
  if (
    ![
      "question.replied",
      "question.rejected",
      "question.v2.replied",
      "question.v2.rejected",
    ].includes(type)
  )
    return undefined;
  const properties = asRecord(payload.properties ?? event.properties);
  const data = asRecord(payload.data ?? event.data ?? properties.data);
  const requestId = data.requestID ?? properties.requestID;
  return typeof requestId === "string" ? requestId : undefined;
}

function responseItems(value: unknown): unknown[] {
  const data = resultData(value);
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  return Array.isArray(record.data) ? record.data : [];
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, QUESTION_RECONCILIATION_INTERVAL_MS);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly key = "OPENCODE" as const;
  readonly capabilities = {
    webSearch: true,
    questions: true,
    import: true,
    pause: true,
    steering: true,
    resume: true,
    nativeDelete: true,
  } as const;
  private runtime?: Awaited<ReturnType<typeof createOpencode>>;

  private async client(): Promise<OpencodeClient> {
    this.runtime ??= await createOpencode();
    return this.runtime.client;
  }

  async catalog(): Promise<ProviderCatalog> {
    const client = await this.client();
    const response = asRecord(resultData(await client.v2.model.list()));
    const models = Array.isArray(response.data) ? response.data : [];
    return {
      models: models
        .map((value) => {
          const model = asRecord(value);
          const variants = Array.isArray(model.variants)
            ? model.variants
                .map((variant) => String(asRecord(variant).id))
                .filter(Boolean)
            : [];
          return {
            id: `${String(model.providerID)}/${String(model.id)}`,
            label: String(model.name ?? model.id),
            efforts: [
              "auto",
              ...variants.filter((variant) => variant !== "auto"),
            ],
          };
        })
        .filter(({ id }) => !id.includes("undefined")),
    };
  }

  async start(
    input: ProviderStartInput,
    callbacks: ProviderCallbacks,
  ): Promise<ProviderHandle> {
    const client = await this.client();
    const cwd = input.run.worktree!.folder;
    let nativeId: string;
    if (input.resumeNativeId && input.fork !== false) {
      const forked = resultData(
        await client.session.fork({
          sessionID: input.resumeNativeId,
          directory: cwd,
        }),
      );
      nativeId = String(asRecord(forked).id);
    } else if (input.resumeNativeId) {
      nativeId = input.resumeNativeId;
    } else {
      const created = resultData(
        await client.session.create({
          directory: cwd,
          agent: input.run.kind === "PLAN" ? "plan" : "build",
          permission:
            input.run.kind === "SESSION"
              ? [{ permission: "*", pattern: "*", action: "allow" }]
              : undefined,
        }),
      );
      nativeId = String(asRecord(created).id);
    }
    if (!nativeId || nativeId === "undefined") {
      throw new Error("OpenCode did not return a session ID");
    }
    await callbacks.onNativeId(nativeId, "1.18.4");

    let stopReason: "PAUSED" | "CANCELLED" | null = null;
    const streamController = new AbortController();
    const questionSurfaces = new Map<string, OpenCodeQuestionSurface>();
    const pendingQuestions = new Set<string>();
    let sawQuestion = false;

    const reportQuestion = async (request: OpenCodeQuestionRequest) => {
      if (questionSurfaces.has(request.id)) return;
      questionSurfaces.set(request.id, request.surface);
      pendingQuestions.add(request.id);
      sawQuestion = true;
      try {
        await callbacks.onQuestion(request.id, request.questions);
      } catch (error) {
        questionSurfaces.delete(request.id);
        pendingQuestions.delete(request.id);
        throw error;
      }
    };

    const reconcileQuestions = async () => {
      const [legacy, v2] = await Promise.allSettled([
        client.question.list({ directory: cwd }),
        client.v2.session.question.list({ sessionID: nativeId }),
      ]);
      if (legacy.status === "fulfilled") {
        for (const value of responseItems(legacy.value)) {
          const request = opencodeQuestionRequest(value, "LEGACY");
          if (request?.sessionId === nativeId) await reportQuestion(request);
        }
      }
      if (v2.status === "fulfilled") {
        for (const value of responseItems(v2.value)) {
          const request = opencodeQuestionRequest(value, "V2");
          if (request && (!request.sessionId || request.sessionId === nativeId))
            await reportQuestion(request);
        }
      }
      if (legacy.status === "rejected" && v2.status === "rejected")
        throw legacy.reason;
    };

    const eventTask = (async () => {
      try {
        const subscription = await client.event.subscribe(
          { directory: cwd },
          { signal: streamController.signal },
        );
        for await (const event of subscription.stream) {
          if (eventSessionId(event) !== nativeId) continue;
          const question = opencodeQuestionRequest(event);
          if (question) await reportQuestion(question);
          const resolvedRequestId = opencodeQuestionResolution(event);
          if (resolvedRequestId) pendingQuestions.delete(resolvedRequestId);
          const record = asRecord(event);
          const payload = asRecord(record.payload);
          const type = String(payload.type ?? record.type ?? "event");
          const text = opencodeEventText(event);
          await callbacks.onEvent({
            type: type.toUpperCase().replaceAll(".", "_"),
            summary: (text || type).slice(0, 2_000),
            detailMarkdown: text,
            raw: event,
          });
        }
      } catch (error) {
        if (!streamController.signal.aborted) {
          await callbacks.onEvent({
            type: "ERROR",
            summary: `OpenCode event stream failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    })();

    const questionReconciliationTask = (async () => {
      let errorReported = false;
      while (!streamController.signal.aborted) {
        try {
          await reconcileQuestions();
          errorReported = false;
        } catch (error) {
          if (!errorReported) {
            errorReported = true;
            try {
              await callbacks.onEvent({
                type: "ERROR",
                summary: `OpenCode question reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            } catch {
              // The live event path may still deliver the question.
            }
          }
        }
        await waitForPoll(streamController.signal);
      }
    })();

    const send = async (prompt: string, attachments: StagedAttachment[]) => {
      const response = await client.session.prompt({
        sessionID: nativeId,
        directory: cwd,
        ...(model(input.run.model) ? { model: model(input.run.model) } : {}),
        agent: input.run.kind === "PLAN" ? "plan" : "build",
        variant:
          input.run.effort && input.run.effort !== "auto"
            ? input.run.effort
            : undefined,
        tools: { websearch: input.run.webSearchEnabled },
        parts: [
          { type: "text", text: prompt },
          ...attachments.map((attachment) => ({
            type: "file" as const,
            mime: attachment.contentType,
            filename: attachment.filename,
            url: pathToFileURL(attachment.path).href,
          })),
        ],
      });
      return resultData(response);
    };

    const completion = (async (): Promise<ProviderCompletion> => {
      try {
        let response = await send(input.prompt, input.attachments);
        await reconcileQuestions();
        while (!stopReason && pendingQuestions.size) {
          await waitForPoll(streamController.signal);
        }
        if (!stopReason && sawQuestion) {
          while (!stopReason) {
            const statuses = asRecord(
              resultData(await client.session.status({ directory: cwd })),
            );
            if (asRecord(statuses[nativeId]).type !== "busy") break;
            await waitForPoll(streamController.signal);
          }
          const messages = responseItems(
            await client.session.messages({
              sessionID: nativeId,
              directory: cwd,
              limit: 1,
            }),
          );
          if (messages[0]) response = messages[0];
        }
        const finalOutput = opencodeResponseText(response);
        const info = asRecord(asRecord(response).info);
        const tokens = asRecord(info.tokens);
        await callbacks.onUsage({
          model: input.run.model,
          inputTokens: Number(tokens.input ?? 0),
          outputTokens: Number(tokens.output ?? 0),
          reasoningTokens: Number(tokens.reasoning ?? 0),
          cacheReadTokens: Number(asRecord(tokens.cache).read ?? 0),
          cacheWriteTokens: Number(asRecord(tokens.cache).write ?? 0),
          estimatedCost: Number(info.cost ?? 0),
          pricingSource: "opencode-sdk",
        });
        return stopReason
          ? { status: stopReason, finalOutput }
          : { status: "COMPLETED", finalOutput };
      } catch (error) {
        return stopReason
          ? { status: stopReason }
          : {
              status: "FAILED",
              error: error instanceof Error ? error.message : String(error),
            };
      } finally {
        streamController.abort();
        await Promise.allSettled([eventTask, questionReconciliationTask]);
      }
    })();

    return {
      nativeId,
      completion,
      async interrupt(reason) {
        stopReason = reason;
        await client.v2.session.interrupt({ sessionID: nativeId });
      },
      async steer(prompt, attachments) {
        await send(prompt, attachments);
      },
      async answer(requestId, answers) {
        if (questionSurfaces.get(requestId) === "V2") {
          await client.v2.session.question.reply({
            sessionID: nativeId,
            requestID: requestId,
            questionV2Reply: { answers: answerArrays(answers) },
          });
        } else {
          await client.question.reply({
            requestID: requestId,
            directory: cwd,
            answers: answerArrays(answers),
          });
        }
        pendingQuestions.delete(requestId);
      },
    };
  }

  async delete(nativeId: string, cwd: string): Promise<void> {
    const client = await this.client();
    await client.session.delete({ sessionID: nativeId, directory: cwd });
  }

  async discover(
    worktrees: ProviderImportWorktree[],
  ): Promise<ProviderImportedRun[]> {
    const client = await this.client();
    const results: ProviderImportedRun[] = [];
    const activeResponse = asRecord(
      resultData(await client.v2.session.active()),
    );
    const activeIds = new Set(Object.keys(asRecord(activeResponse.data)));
    for (const worktree of worktrees) {
      let cursor: string | undefined;
      do {
        const response = asRecord(
          resultData(
            await client.v2.session.list({
              directory: worktree.folder,
              limit: 500,
              order: "asc",
              cursor,
            }),
          ),
        );
        const sessions = Array.isArray(response.data) ? response.data : [];
        for (const value of sessions) {
          const session = asRecord(value);
          const time = asRecord(session.time);
          const selectedModel = asRecord(session.model);
          let finalOutput: string | undefined;
          try {
            const messages = asRecord(
              resultData(
                await client.v2.session.messages({
                  sessionID: String(session.id),
                  limit: 1,
                  order: "desc",
                }),
              ),
            );
            finalOutput = firstString(
              Array.isArray(messages.data) ? messages.data[0] : messages,
            );
          } catch {
            // Preserve the list metadata when message hydration is unavailable.
          }
          results.push({
            nativeId: String(session.id),
            worktreeId: worktree.id,
            kind: session.agent === "plan" ? "PLAN" : "SESSION",
            status: activeIds.has(String(session.id))
              ? "IN_PROGRESS"
              : "COMPLETED",
            archived: Boolean(time.archived),
            model:
              typeof selectedModel.providerID === "string" &&
              typeof selectedModel.id === "string"
                ? `${selectedModel.providerID}/${selectedModel.id}`
                : undefined,
            prompt:
              firstString(session.title ?? session.summary) ||
              "Imported OpenCode session",
            finalOutput: finalOutput || firstString(session.summary),
            branch: worktree.branch || undefined,
            createdAt: time.created
              ? new Date(Number(time.created)).toISOString()
              : undefined,
            updatedAt: time.updated
              ? new Date(Number(time.updated)).toISOString()
              : undefined,
            rawMetadata: session,
          });
        }
        cursor =
          typeof asRecord(response.cursor).next === "string"
            ? String(asRecord(response.cursor).next)
            : undefined;
      } while (cursor);
    }
    return results;
  }

  async close(): Promise<void> {
    this.runtime?.server.close();
    this.runtime = undefined;
  }
}
