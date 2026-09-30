import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk/v2";

import { findExecutable, prependPathDirectory } from "../executable-lookup.js";
import {
  opencodeImportedHistory,
  opencodeTimestamp,
} from "./opencode-import.js";

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
const QUESTION_RECONCILIATION_TIMEOUT_MS = 5_000;
const POST_ANSWER_COMPLETION_TIMEOUT_MS = 15 * 60_000;
// The message endpoint rejects larger pages (the session list only clamps them).
const IMPORT_PAGE_SIZE = 200;

type OpenCodeQuestionSurface = "LEGACY" | "V2";

type OpenCodeQuestionRequest = {
  id: string;
  sessionId?: string;
  surface: OpenCodeQuestionSurface;
  questions: ProviderQuestion[];
};

type OpenCodePermissionRequest = {
  id: string;
  sessionId?: string;
  surface: OpenCodeQuestionSurface;
  permission: string;
  patterns: string[];
  always: string[];
};

type OpenCodePermissionReply = "once" | "always" | "reject";

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

export function opencodePartType(value: unknown): string | undefined {
  const event = asRecord(value);
  const payload = asRecord(event.payload);
  const body = asRecord(
    payload.properties ?? payload.data ?? event.properties ?? event.data,
  );
  const part = asRecord(body.part);
  return typeof part.type === "string" ? part.type : undefined;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function opencodePermissionRequest(
  value: unknown,
  fallbackSurface?: OpenCodeQuestionSurface,
): OpenCodePermissionRequest | null {
  const event = asRecord(value);
  const payload = asRecord(event.payload);
  const type = String(payload.type ?? event.type ?? "");
  if (type && type !== "permission.asked" && type !== "permission.v2.asked")
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
  const permission = request.permission ?? request.action;
  if (typeof permission !== "string") return null;
  return {
    id: String(request.id ?? properties.id ?? "permission"),
    sessionId:
      typeof request.sessionID === "string"
        ? request.sessionID
        : typeof properties.sessionID === "string"
          ? properties.sessionID
          : undefined,
    surface:
      type === "permission.v2.asked" ? "V2" : (fallbackSurface ?? "LEGACY"),
    permission,
    patterns: stringArray(request.patterns ?? request.resources),
    always: stringArray(request.always ?? request.save),
  };
}

function opencodePermissionResolution(value: unknown): string | undefined {
  const event = asRecord(value);
  const payload = asRecord(event.payload);
  const type = String(payload.type ?? event.type ?? "");
  if (type !== "permission.replied" && type !== "permission.v2.replied")
    return undefined;
  const properties = asRecord(payload.properties ?? event.properties);
  const data = asRecord(payload.data ?? event.data ?? properties.data);
  const requestId = data.requestID ?? properties.requestID;
  return typeof requestId === "string" ? requestId : undefined;
}

function permissionQuestions(
  request: OpenCodePermissionRequest,
): ProviderQuestion[] {
  const permission = request.permission.replaceAll("_", " ");
  const targets = request.patterns.length
    ? ` for ${request.patterns.join(", ")}`
    : "";
  return [
    {
      id: "permission",
      header: "Permission required",
      prompt: `OpenCode requests ${permission} permission${targets}.`,
      multiSelect: false,
      allowCustom: false,
      options: [
        {
          label: "Allow once",
          description: "Approve only this request.",
        },
        ...(request.always.length
          ? [
              {
                label: "Always allow",
                description: `Approve this request and remember ${request.always.join(", ")}.`,
              },
            ]
          : []),
        {
          label: "Reject",
          description: "Deny this request and let OpenCode continue safely.",
        },
      ],
    },
  ];
}

function permissionReply(value: unknown): OpenCodePermissionReply {
  const selected = answerArrays(value)
    .flat()
    .map((answer) => answer.trim().toLowerCase())
    .filter(Boolean);
  if (selected.length !== 1)
    throw new Error("Select one response for the OpenCode permission request");
  switch (selected[0]) {
    case "allow once":
    case "once":
      return "once";
    case "always allow":
    case "allow always":
    case "always":
      return "always";
    case "reject":
    case "deny":
      return "reject";
    default:
      throw new Error(`Unknown OpenCode permission response: ${selected[0]}`);
  }
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
  private hydrationCache = new Map<
    string,
    { key: string; history: Partial<ProviderImportedRun> }
  >();

  private async client(): Promise<OpencodeClient> {
    // The SDK spawns `opencode` by bare name through cross-spawn, so the only
    // lever is the PATH it inherits. Resolve first to fail with instructions
    // instead of an opaque ENOENT, and to honor an explicitly pinned install.
    if (!this.runtime) {
      const executable = findExecutable("opencode", {
        overrideVariable: "CONTROL_AGENT_OPENCODE_EXECUTABLE",
      });
      if (!executable) {
        throw new Error(
          "opencode was not found. Install it (brew install sst/tap/opencode, or npm install -g opencode-ai) or set CONTROL_AGENT_OPENCODE_EXECUTABLE to its full path.",
        );
      }
      prependPathDirectory(dirname(executable));
      // Bind an ephemeral port. The SDK otherwise defaults to 4096, where a
      // user's own `opencode serve` — or one orphaned by a control agent that
      // was killed before it could close its runtime — makes the spawn exit
      // with `ServeError` and takes the whole provider offline.
      this.runtime = await createOpencode({ port: 0 });
    }
    return this.runtime.client;
  }

  async catalog(): Promise<ProviderCatalog> {
    const client = await this.client();
    // `v2.model.list` only reports the anonymous OpenCode Zen catalog — it
    // leaves out every authenticated provider, OpenCode Go included. The
    // config endpoint is the one that resolves auth, so ask it instead.
    const response = asRecord(resultData(await client.config.providers()));
    const providers = Array.isArray(response.providers)
      ? response.providers
      : [];
    return {
      models: providers
        .flatMap((value) => {
          const provider = asRecord(value);
          const providerId = String(provider.id);
          const released = (value: unknown) =>
            String(asRecord(value).release_date ?? "");
          return Object.entries(asRecord(provider.models))
            .sort(([, left], [, right]) =>
              released(right).localeCompare(released(left)),
            )
            .map(([modelId, value]) => {
              const model = asRecord(value);
              const variants = Object.keys(asRecord(model.variants));
              return {
                id: `${providerId}/${modelId}`,
                label: String(model.name ?? modelId),
                efforts: [
                  "auto",
                  ...variants.filter((variant) => variant !== "auto"),
                ],
                /*
                 * OpenCode fronts several catalogs — Go and Zen today — that
                 * the picker shows under one provider. Carrying each one's
                 * own name lets it split them into sections without the UI
                 * having to recognise provider ids.
                 */
                group: String(provider.name ?? providerId),
              };
            });
        })
        .filter(({ id }) => !id.includes("undefined")),
    };
  }

  async start(
    input: ProviderStartInput,
    callbacks: ProviderCallbacks,
  ): Promise<ProviderHandle> {
    const isolatedRuntime = input.mcpServer
      ? await createOpencode({
          port: 0,
          config: {
            mcp: {
              [input.mcpServer.name]: {
                type: "remote",
                url: input.mcpServer.url,
                headers: input.mcpServer.headers,
                oauth: false,
              },
            },
          },
        })
      : undefined;
    const client = isolatedRuntime?.client ?? (await this.client());
    const cwd = input.run.worktree!.folder;
    let nativeId: string;
    try {
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
    } catch (error) {
      isolatedRuntime?.server.close();
      throw error;
    }

    let stopReason: "PAUSED" | "CANCELLED" | null = null;
    const streamController = new AbortController();
    const questionSurfaces = new Map<string, OpenCodeQuestionSurface>();
    const permissionSurfaces = new Map<string, OpenCodeQuestionSurface>();
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

    const reportPermission = async (request: OpenCodePermissionRequest) => {
      if (permissionSurfaces.has(request.id)) return;
      permissionSurfaces.set(request.id, request.surface);
      pendingQuestions.add(request.id);
      sawQuestion = true;
      try {
        await callbacks.onQuestion(request.id, permissionQuestions(request));
      } catch (error) {
        permissionSurfaces.delete(request.id);
        pendingQuestions.delete(request.id);
        throw error;
      }
    };

    const reconcileLegacyQuestions = async () => {
      const response = await client.question.list(
        { directory: cwd },
        { signal: AbortSignal.timeout(QUESTION_RECONCILIATION_TIMEOUT_MS) },
      );
      const items = responseItems(response);
      for (const value of items) {
        const request = opencodeQuestionRequest(value, "LEGACY");
        if (request?.sessionId === nativeId) await reportQuestion(request);
      }
    };

    const reconcileV2Questions = async () => {
      const response = await client.v2.session.question.list(
        { sessionID: nativeId },
        { signal: AbortSignal.timeout(QUESTION_RECONCILIATION_TIMEOUT_MS) },
      );
      for (const value of responseItems(response)) {
        const request = opencodeQuestionRequest(value, "V2");
        if (request && (!request.sessionId || request.sessionId === nativeId))
          await reportQuestion(request);
      }
    };

    const reconcileLegacyPermissions = async () => {
      const response = await client.permission.list(
        { directory: cwd },
        { signal: AbortSignal.timeout(QUESTION_RECONCILIATION_TIMEOUT_MS) },
      );
      for (const value of responseItems(response)) {
        const request = opencodePermissionRequest(value, "LEGACY");
        if (request?.sessionId === nativeId) await reportPermission(request);
      }
    };

    const reconcileV2Permissions = async () => {
      const response = await client.v2.session.permission.list(
        { sessionID: nativeId },
        { signal: AbortSignal.timeout(QUESTION_RECONCILIATION_TIMEOUT_MS) },
      );
      for (const value of responseItems(response)) {
        const request = opencodePermissionRequest(value, "V2");
        if (request && (!request.sessionId || request.sessionId === nativeId))
          await reportPermission(request);
      }
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
          const permission = opencodePermissionRequest(event);
          if (permission) await reportPermission(permission);
          const resolvedRequestId = opencodeQuestionResolution(event);
          if (resolvedRequestId) pendingQuestions.delete(resolvedRequestId);
          const resolvedPermissionId = opencodePermissionResolution(event);
          if (resolvedPermissionId)
            pendingQuestions.delete(resolvedPermissionId);
          const record = asRecord(event);
          const payload = asRecord(record.payload);
          const type = String(payload.type ?? record.type ?? "event");
          // Text and reasoning parts stream one update per chunk; skip them so
          // the journal is not flooded. Tool parts and the final
          // message.updated event still record a single entry each.
          if (type === "message.part.updated") {
            const partType = opencodePartType(event);
            if (partType === "text" || partType === "reasoning") continue;
          }
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

    const questionReconciliationTask = (
      surface: string,
      reconcile: () => Promise<void>,
    ) =>
      (async () => {
        let errorReported = false;
        while (!streamController.signal.aborted) {
          try {
            await reconcile();
            errorReported = false;
          } catch (error) {
            if (!errorReported) {
              errorReported = true;
              try {
                await callbacks.onEvent({
                  type: "ERROR",
                  summary: `OpenCode ${surface.toLowerCase()} question reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
                });
              } catch {
                // The live event path may still deliver the question.
              }
            }
          }
          await waitForPoll(streamController.signal);
        }
      })();
    const legacyQuestionReconciliationTask = questionReconciliationTask(
      "LEGACY",
      reconcileLegacyQuestions,
    );
    const v2QuestionReconciliationTask = questionReconciliationTask(
      "V2",
      reconcileV2Questions,
    );
    const legacyPermissionReconciliationTask = questionReconciliationTask(
      "LEGACY permission",
      reconcileLegacyPermissions,
    );
    const v2PermissionReconciliationTask = questionReconciliationTask(
      "V2 permission",
      reconcileV2Permissions,
    );

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
        await Promise.allSettled([
          reconcileLegacyQuestions(),
          reconcileV2Questions(),
          reconcileLegacyPermissions(),
          reconcileV2Permissions(),
        ]);
        while (!stopReason && pendingQuestions.size) {
          await waitForPoll(streamController.signal);
        }
        if (!stopReason && sawQuestion) {
          const busyDeadline = Date.now() + POST_ANSWER_COMPLETION_TIMEOUT_MS;
          while (!stopReason && Date.now() < busyDeadline) {
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
        await Promise.allSettled([
          eventTask,
          legacyQuestionReconciliationTask,
          v2QuestionReconciliationTask,
          legacyPermissionReconciliationTask,
          v2PermissionReconciliationTask,
        ]);
        isolatedRuntime?.server.close();
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
        const permissionSurface = permissionSurfaces.get(requestId);
        if (permissionSurface === "V2") {
          await client.v2.session.permission.reply({
            sessionID: nativeId,
            requestID: requestId,
            reply: permissionReply(answers),
          });
        } else if (permissionSurface === "LEGACY") {
          await client.permission.reply({
            requestID: requestId,
            directory: cwd,
            reply: permissionReply(answers),
          });
        } else if (questionSurfaces.get(requestId) === "V2") {
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
        permissionSurfaces.delete(requestId);
      },
    };
  }

  async delete(nativeId: string, cwd: string): Promise<void> {
    const client = await this.client();
    await client.session.delete({ sessionID: nativeId, directory: cwd });
  }

  private async legacyHistory(
    client: OpencodeClient,
    nativeId: string,
    directory: string,
  ): Promise<unknown[]> {
    const messages: unknown[] = [];
    const seenCursors = new Set<string>();
    let before: string | undefined;
    do {
      const response = await client.session.messages(
        {
          sessionID: nativeId,
          directory,
          limit: IMPORT_PAGE_SIZE,
          ...(before ? { before } : {}),
        },
        { throwOnError: true },
      );
      const page = resultData(response);
      if (!Array.isArray(page))
        throw new Error("Invalid legacy OpenCode message history");
      messages.push(...page);
      // `before` is an opaque cursor, not a message ID. Older releases return
      // their complete history without this header.
      before = response.response?.headers.get("x-next-cursor") ?? undefined;
      if (before && seenCursors.has(before))
        throw new Error("Repeated legacy OpenCode message cursor");
      if (before) seenCursors.add(before);
    } while (before);
    return messages;
  }

  private async importedHistory(
    client: OpencodeClient,
    nativeId: string,
    directory: string,
    surface: "V2" | "LEGACY",
  ): Promise<unknown[]> {
    if (surface === "LEGACY")
      return this.legacyHistory(client, nativeId, directory);
    const messages: unknown[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    try {
      do {
        const page = asRecord(
          resultData(
            await client.v2.session.messages(
              {
                sessionID: nativeId,
                limit: IMPORT_PAGE_SIZE,
                ...(cursor ? { cursor } : { order: "asc" }),
              },
              { throwOnError: true },
            ),
          ),
        );
        if (!Array.isArray(page.data))
          throw new Error("Invalid OpenCode message history");
        messages.push(...page.data);
        cursor =
          typeof asRecord(page.cursor).next === "string"
            ? String(asRecord(page.cursor).next)
            : undefined;
        if (cursor && seenCursors.has(cursor))
          throw new Error("Repeated OpenCode message cursor");
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
    } catch (error) {
      // A failure after the first page must not replace complete native history
      // with a partial snapshot from another API.
      if (messages.length || cursor) throw error;
      return this.legacyHistory(client, nativeId, directory);
    }
    if (messages.length) return messages;
    // The v2 list also includes legacy sessions whose projected v2 history is
    // empty. Their transcript remains available from the compatibility API.
    try {
      return await this.legacyHistory(client, nativeId, directory);
    } catch (error) {
      const name = String(asRecord(error)._tag ?? asRecord(error).name ?? "");
      if (["NotFoundError", "SessionNotFoundError"].includes(name))
        return messages;
      throw error;
    }
  }

  async discover(
    worktrees: ProviderImportWorktree[],
  ): Promise<ProviderImportedRun[]> {
    const client = await this.client();
    const results: ProviderImportedRun[] = [];
    const hydrationFailures: string[] = [];
    let hydratedCount = 0;
    const activeIds = new Set<string>();
    try {
      const active = asRecord(
        resultData(await client.v2.session.active({ throwOnError: true })),
      );
      for (const id of Object.keys(asRecord(active.data))) activeIds.add(id);
    } catch {
      // Older installations expose only the legacy status endpoint.
    }
    for (const worktree of worktrees) {
      const sessions = new Map<
        string,
        { session: Record<string, unknown>; surface: "V2" | "LEGACY" }
      >();
      let listed = false;
      let listError: unknown;
      try {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          const response = asRecord(
            resultData(
              await client.v2.session.list(
                {
                  directory: worktree.folder,
                  limit: IMPORT_PAGE_SIZE,
                  ...(cursor ? { cursor } : { order: "asc" }),
                },
                { throwOnError: true },
              ),
            ),
          );
          if (!Array.isArray(response.data))
            throw new Error("Invalid OpenCode session list");
          for (const value of response.data) {
            const session = asRecord(value);
            if (typeof session.id === "string")
              sessions.set(session.id, { session, surface: "V2" });
          }
          cursor =
            typeof asRecord(response.cursor).next === "string"
              ? String(asRecord(response.cursor).next)
              : undefined;
          if (cursor && seenCursors.has(cursor))
            throw new Error("Repeated OpenCode session cursor");
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        listed = true;
      } catch (error) {
        listError = error;
      }
      // Native v2 and legacy installations can have separate session stores.
      try {
        const legacy = resultData(
          await client.session.list(
            { directory: worktree.folder, limit: IMPORT_PAGE_SIZE },
            { throwOnError: true },
          ),
        );
        if (!Array.isArray(legacy))
          throw new Error("Invalid legacy OpenCode session list");
        for (const value of legacy) {
          const session = asRecord(value);
          if (typeof session.id === "string" && !sessions.has(session.id))
            sessions.set(session.id, { session, surface: "LEGACY" });
        }
        listed = true;
      } catch (error) {
        listError ??= error;
      }
      if (!listed) throw listError;
      try {
        const statuses = asRecord(
          resultData(
            await client.session.status(
              { directory: worktree.folder },
              { throwOnError: true },
            ),
          ),
        );
        for (const [id, value] of Object.entries(statuses))
          if (["busy", "retry"].includes(String(asRecord(value).type)))
            activeIds.add(id);
      } catch {
        // Native v2 activity is still available when the legacy API is absent.
      }
      for (const [nativeId, { session, surface }] of sessions) {
        const directory =
          session.directory ?? asRecord(session.location).directory;
        if (
          typeof directory === "string" &&
          resolve(directory) !== resolve(worktree.folder)
        )
          continue;
        const time = asRecord(session.time);
        const active = activeIds.has(nativeId);
        const key = JSON.stringify([
          surface,
          time.updated,
          session.cost,
          session.tokens,
          session.model,
        ]);
        const cached = this.hydrationCache.get(nativeId);
        if (active) this.hydrationCache.delete(nativeId);
        let history: Partial<ProviderImportedRun> = {};
        if (!active && cached?.key === key) history = cached.history;
        else {
          try {
            const messages = await this.importedHistory(
              client,
              nativeId,
              worktree.folder,
              surface,
            );
            history = opencodeImportedHistory(session, messages);
            if (!active) this.hydrationCache.set(nativeId, { key, history });
          } catch (error) {
            // A partial read must never replace a previously complete snapshot.
            const detail =
              error instanceof Error
                ? error.message
                : (firstString(asRecord(error).message) ??
                  String(asRecord(error)._tag ?? error));
            hydrationFailures.push(`${nativeId}: ${detail}`);
          }
        }
        if (history.events) hydratedCount += 1;
        results.push({
          nativeId,
          worktreeId: worktree.id,
          ...(typeof session.cost === "number" &&
          Number.isFinite(session.cost) &&
          session.cost >= 0
            ? { estimatedCost: session.cost, pricingSource: "opencode-history" }
            : {}),
          ...history,
          kind: history.kind ?? (session.agent === "plan" ? "PLAN" : "SESSION"),
          status: active ? "IN_PROGRESS" : (history.status ?? "COMPLETED"),
          archived: Boolean(time.archived),
          model: history.model,
          prompt:
            history.prompt ??
            firstString(session.title) ??
            "Imported OpenCode session",
          branch: worktree.branch || undefined,
          createdAt: opencodeTimestamp(time.created),
          updatedAt: opencodeTimestamp(time.updated),
          rawMetadata: session,
        });
      }
    }
    if (hydrationFailures.length) {
      const detail = `OpenCode history unavailable for ${hydrationFailures.length} sessions: ${hydrationFailures.slice(0, 3).join("; ")}`;
      if (!hydratedCount) throw new Error(detail);
      console.warn(detail);
    }
    return results;
  }

  async close(): Promise<void> {
    this.runtime?.server.close();
    this.runtime = undefined;
  }
}
