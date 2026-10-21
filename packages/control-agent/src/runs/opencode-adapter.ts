import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { OpenCodeClient } from "@opencode/client";
import {
  parseRunQuestionField,
  runFormAnswers,
  type RunQuestionField,
} from "@ai-development-environment/agent-contract/run-forms";
import { OpenCodeRuntime, sharedOpenCodeClient } from "./opencode-runtime.js";
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

const PAGE_SIZE = 200;
const requestOptions = () => ({ signal: AbortSignal.timeout(10_000) });
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function opencodeResponseText(value: unknown): string {
  const record = asRecord(value);
  const content = Array.isArray(record.content) ? record.content : [];
  return content
    .map(asRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text).trim())
    .filter(Boolean)
    .join("\n\n");
}
export function opencodeEventText(value: unknown): string | undefined {
  const data = asRecord(asRecord(value).data);
  return firstString(data.text ?? data.content ?? data.error);
}
export function opencodeQuestions(
  value: unknown,
): { id: string; questions: ProviderQuestion[] } | null {
  const event = asRecord(value);
  if (event.type && event.type !== "form.created") return null;
  const form = event.type ? asRecord(asRecord(event.data).form) : event;
  if (typeof form.id !== "string" || !Array.isArray(form.fields)) return null;
  return {
    id: form.id,
    questions: form.fields.map((value) => {
      const field = parseRunQuestionField(value);
      return {
        id: field.key,
        header: String(form.title ?? ""),
        prompt: field.title || field.description || field.key,
        multiSelect: field.type === "multiselect",
        allowCustom:
          (field.type === "string" || field.type === "multiselect") &&
          field.custom === true,
        options:
          "options" in field
            ? field.options?.map(({ label, description }) => ({
                label,
                description,
              }))
            : [],
        field,
      };
    }),
  };
}
function permissionQuestions(
  request: Record<string, unknown>,
): ProviderQuestion[] {
  return [
    {
      id: "permission",
      header: "Permission",
      prompt: String(
        request.message ??
          `OpenCode requests ${String(request.action)} permission: ${Array.isArray(request.resources) ? request.resources.join(", ") : ""}`,
      ),
      allowCustom: false,
      options: [
        { label: "Allow once" },
        { label: "Always allow" },
        { label: "Reject" },
      ],
    },
  ];
}
function permissionDecision(answers: unknown): "once" | "always" | "reject" {
  const selected = answerArrays(answers).flat();
  if (selected.length !== 1)
    throw new Error("Select one response for the OpenCode permission request");
  switch (selected[0]?.toLowerCase()) {
    case "allow once":
    case "once":
      return "once";
    case "always allow":
    case "always":
      return "always";
    case "reject":
      return "reject";
    default:
      throw new Error(`Unknown OpenCode permission response: ${selected[0]}`);
  }
}
function selectedModel(input: ProviderStartInput) {
  const value = input.run.model;
  const separator = value.indexOf("/");
  if (!value || value === "default" || separator < 1) return undefined;
  return {
    providerID: value.slice(0, separator),
    id: value.slice(separator + 1),
    ...(input.run.effort && input.run.effort !== "auto"
      ? { variant: input.run.effort }
      : {}),
  };
}
async function paginated<T>(
  read: (
    cursor?: string,
  ) => Promise<{ data: T[]; cursor: { next?: string | null } }>,
): Promise<T[]> {
  const results: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    if (!Array.isArray(page.data)) throw new Error("Invalid OpenCode page");
    results.push(...page.data);
    cursor = page.cursor?.next ?? undefined;
    if (cursor && seen.has(cursor))
      throw new Error("Repeated OpenCode pagination cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return results;
}
export const openCodeMessages = (client: OpenCodeClient, sessionID: string) =>
  paginated((cursor) =>
    client.message.list(
      {
        sessionID,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : { order: "asc" }),
      },
      requestOptions(),
    ),
  );

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
  private runtime = new OpenCodeRuntime();
  private isolated = new Set<OpenCodeRuntime>();
  private hydrationCache = new Map<
    string,
    { key: string; history: Partial<ProviderImportedRun> }
  >();

  async catalog(
    worktrees: ProviderImportWorktree[] = [],
  ): Promise<ProviderCatalog> {
    const { client } = await this.runtime.client();
    const read = async (
      directory?: string,
    ): Promise<ProviderCatalog["models"]> => {
      const location = directory ? { directory } : undefined;
      const [models, providers] = await Promise.all([
        client.model.list({ location }, requestOptions()),
        client.provider.list({ location }, requestOptions()),
      ]);
      const names = new Map(
        providers.data
          .filter((provider) => provider.activation !== "disabled")
          .map((provider) => [provider.id, provider.name]),
      );
      return models.data
        .filter((model) => model.enabled && names.has(model.providerID))
        .map((model) => ({
          id: `${model.providerID}/${model.id}`,
          label: model.name,
          efforts: [
            "auto",
            ...model.variants
              .map((variant) => variant.id)
              .filter((id) => id !== "auto"),
          ],
          group: names.get(model.providerID),
        }));
    };
    const scoped: NonNullable<ProviderCatalog["worktrees"]> = {};
    for (const worktree of worktrees)
      scoped[worktree.id] = { models: await read(worktree.folder) };
    return { models: await read(), worktrees: scoped };
  }

  async start(
    input: ProviderStartInput,
    callbacks: ProviderCallbacks,
  ): Promise<ProviderHandle> {
    const isolated = input.mcpServer ? new OpenCodeRuntime(true) : undefined;
    if (isolated) this.isolated.add(isolated);
    let closed = false;
    const cleanup = async () => {
      if (isolated && !closed) {
        closed = true;
        this.isolated.delete(isolated);
        await isolated.close();
      }
    };
    let client: OpenCodeClient;
    let nativeId: string;
    let initial: Set<string>;
    const cwd = resolve(input.run.worktree!.folder);
    try {
      const runtime = await (isolated ?? this.runtime).client();
      client = runtime.client;
      await this.migrationReady(client);
      if (input.mcpServer)
        await client.mcp.add(
          {
            server: input.mcpServer.name,
            location: { directory: cwd },
            config: {
              type: "remote",
              url: input.mcpServer.url,
              headers: input.mcpServer.headers,
              oauth: false,
            },
          },
          requestOptions(),
        );
      const agent = input.run.kind === "PLAN" ? "plan" : "build";
      const permissions = [
        ...(input.run.kind === "SESSION"
          ? [{ action: "*", resource: "*", effect: "allow" as const }]
          : []),
        {
          action: "websearch",
          resource: "*",
          effect: input.run.webSearchEnabled
            ? ("allow" as const)
            : ("deny" as const),
        },
      ];
      if (input.resumeNativeId) {
        const session =
          input.fork !== false
            ? await client.session.fork(
                { sessionID: input.resumeNativeId },
                requestOptions(),
              )
            : await client.session.get(
                { sessionID: input.resumeNativeId },
                requestOptions(),
              );
        nativeId = session.id;
        if (resolve(session.location.directory) !== cwd) {
          if (input.fork === false)
            throw new Error(
              "Cannot continue an OpenCode session in a different worktree; fork it instead",
            );
          await client.session.move(
            { sessionID: nativeId, directory: cwd },
            requestOptions(),
          );
          await client.session.wait({ sessionID: nativeId }, requestOptions());
        }
        await client.session.switchAgent(
          { sessionID: nativeId, agent },
          requestOptions(),
        );
        const model = selectedModel(input);
        if (model)
          await client.session.switchModel(
            { sessionID: nativeId, model },
            requestOptions(),
          );
        await client.session.update(
          { sessionID: nativeId, permissions },
          requestOptions(),
        );
      } else {
        const session = await client.session.create(
          {
            location: { directory: cwd },
            agent,
            model: selectedModel(input),
            permissions,
          },
          requestOptions(),
        );
        nativeId = session.id;
      }
      if (!nativeId) throw new Error("OpenCode did not return a session ID");
      initial = new Set(
        (await openCodeMessages(client, nativeId)).map((entry) => entry.id),
      );
      await callbacks.onNativeId(nativeId, runtime.version);
    } catch (error) {
      await cleanup();
      throw error;
    }

    let stopReason: "PAUSED" | "CANCELLED" | undefined;
    const controller = new AbortController();
    const executionController = new AbortController();
    const resolvedRequests = new Set<string>();
    const pending = new Map<
      string,
      {
        kind: "form" | "permission";
        fields: RunQuestionField[];
        ready: Promise<void>;
      }
    >();
    const report = async (
      id: string,
      kind: "form" | "permission",
      questions: ProviderQuestion[],
    ) => {
      if (pending.has(id) || resolvedRequests.has(id)) return;
      const ready = callbacks.onQuestion(id, questions);
      pending.set(id, {
        kind,
        fields: questions.flatMap((question) =>
          question.field ? [question.field] : [],
        ),
        ready,
      });
      try {
        await ready;
      } catch (error) {
        pending.delete(id);
        throw error;
      }
    };
    const settle = async (
      id: string,
      status: "ANSWERED" | "CANCELLED",
      answers?: unknown,
    ) => {
      const request = pending.get(id);
      if (!request) return;
      await request.ready;
      await callbacks.onQuestionResolved?.(id, { status, answers });
      resolvedRequests.add(id);
      pending.delete(id);
    };
    const reconcile = async () => {
      const previouslyPending = new Set(pending.keys());
      const [forms, permissions] = await Promise.all([
        client.session.form.list({ sessionID: nativeId }, requestOptions()),
        client.permission.list({ sessionID: nativeId }, requestOptions()),
      ]);
      for (const form of forms) {
        const request = opencodeQuestions(form);
        if (request) await report(request.id, "form", request.questions);
      }
      for (const permission of permissions)
        await report(
          permission.id,
          "permission",
          permissionQuestions(asRecord(permission)),
        );
      for (const [id, request] of pending) {
        if (!previouslyPending.has(id)) continue;
        if (
          request.kind === "permission" &&
          !permissions.some((permission) => permission.id === id)
        )
          await settle(id, "ANSWERED");
        if (request.kind === "form" && !forms.some((form) => form.id === id)) {
          const detail = await client.session.form.get(
            { sessionID: nativeId, formID: id },
            requestOptions(),
          );
          if (detail.state.status === "answered")
            await settle(
              id,
              "ANSWERED",
              Object.fromEntries(
                Object.entries(detail.state.answer).map(([key, value]) => [
                  key,
                  { value },
                ]),
              ),
            );
          else if (detail.state.status === "cancelled")
            await settle(id, "CANCELLED");
        }
      }
    };
    const toolSnapshots = new Map<string, string>();
    const emitSnapshot = async (
      event: Parameters<ProviderCallbacks["onEvent"]>[0],
    ) => {
      const part = asRecord(asRecord(asRecord(event.raw).properties).part);
      if (part.type === "tool") {
        const key = `${String(part.messageID)}:${String(part.id)}`;
        const snapshot = JSON.stringify(part);
        if (toolSnapshots.get(key) === snapshot) return;
        toolSnapshots.set(key, snapshot);
      }
      await callbacks.onEvent(event);
    };
    let delivery = Promise.resolve();
    const events = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of client.event.subscribe({
            signal: controller.signal,
          })) {
            const record = asRecord(event);
            const data = asRecord(record.data);
            if (
              (data.sessionID ?? asRecord(data.form).sessionID) !== nativeId ||
              String(event.type).endsWith(".delta")
            )
              continue;
            // Drain the live-only stream promptly; persist events in order off the reader.
            delivery = delivery
              .then(async () => {
                const form = opencodeQuestions(event);
                if (form) await report(form.id, "form", form.questions);
                if (event.type === "permission.asked")
                  await report(
                    String(data.id),
                    "permission",
                    permissionQuestions(data),
                  );
                if (event.type === "form.replied")
                  await settle(
                    String(data.id),
                    "ANSWERED",
                    Object.fromEntries(
                      Object.entries(asRecord(data.answer)).map(
                        ([key, value]) => [key, { value }],
                      ),
                    ),
                  );
                if (event.type === "form.cancelled")
                  await settle(String(data.id), "CANCELLED");
                if (event.type === "permission.replied")
                  await settle(String(data.requestID), "ANSWERED");
                if (
                  [
                    "session.tool.called",
                    "session.tool.success",
                    "session.tool.failed",
                  ].includes(String(event.type)) &&
                  typeof data.assistantMessageID === "string"
                ) {
                  const nativeMessage = await client.session.message.get(
                    { sessionID: nativeId, messageID: data.assistantMessageID },
                    requestOptions(),
                  );
                  const history = opencodeImportedHistory({ id: nativeId }, [
                    nativeMessage,
                  ]);
                  for (const snapshot of history.events ?? []) {
                    const part = asRecord(
                      asRecord(asRecord(snapshot.raw).properties).part,
                    );
                    if (part.type === "tool" && part.id === data.id)
                      await emitSnapshot(snapshot);
                  }
                }
                await callbacks.onEvent({
                  type: String(event.type).toUpperCase().replaceAll(".", "_"),
                  summary: (
                    opencodeEventText(event) || String(event.type)
                  ).slice(0, 2_000),
                  raw: event,
                });
              })
              .catch((error: unknown) => {
                console.error(
                  "OpenCode event delivery failed:",
                  message(error),
                );
              });
          }
        } catch (error) {
          if (!controller.signal.aborted)
            console.error(
              "OpenCode event stream reconnecting:",
              message(error),
            );
        }
        if (!controller.signal.aborted)
          await delay(1_000, undefined, { signal: controller.signal }).catch(
            () => undefined,
          );
      }
    })();
    const polling = (async () => {
      let warned = false;
      while (!controller.signal.aborted) {
        try {
          await reconcile();
          warned = false;
        } catch (error) {
          if (!warned && !controller.signal.aborted) {
            warned = true;
            await callbacks
              .onEvent({
                type: "ERROR",
                summary: `OpenCode question reconciliation failed: ${message(error)}`,
              })
              .catch(() => undefined);
          }
        }
        await delay(1_000, undefined, { signal: controller.signal }).catch(
          () => undefined,
        );
      }
    })();
    const send = (
      text: string,
      attachments: StagedAttachment[],
      steer = false,
    ) =>
      client.session.prompt(
        {
          sessionID: nativeId,
          text,
          files: attachments.map((attachment) => ({
            uri: pathToFileURL(attachment.path).href,
            name: attachment.filename,
          })),
          ...(steer ? { delivery: "steer" as const } : {}),
        },
        requestOptions(),
      );
    const completion = (async (): Promise<ProviderCompletion> => {
      try {
        const receipt = await send(input.prompt, input.attachments);
        let session;
        let messages;
        while (!stopReason) {
          // prompt() acknowledges durable input. wait() waits for execution to become idle.
          try {
            await client.session.wait(
              { sessionID: nativeId },
              {
                signal: AbortSignal.any([
                  executionController.signal,
                  AbortSignal.timeout(30_000),
                ]),
              },
            );
          } catch (error) {
            if (!stopReason && executionController.signal.aborted) throw error;
          }
          session = await client.session.get(
            { sessionID: nativeId },
            requestOptions(),
          );
          messages = (await openCodeMessages(client, nativeId)).filter(
            (entry) => !initial.has(entry.id),
          );
          const idle = messages.findLast((entry) => entry.type === "idle");
          if (
            idle &&
            idle.time.created >= receipt.time.created &&
            !pending.size &&
            !Object.hasOwn(
              await client.session.active(requestOptions()),
              nativeId,
            ) &&
            !(
              await client.session.inbox.list(
                { sessionID: nativeId },
                requestOptions(),
              )
            ).length
          )
            break;
          if (!stopReason)
            await delay(500, undefined, {
              signal: executionController.signal,
            }).catch((error: unknown) => {
              if (!stopReason) throw error;
            });
        }
        session ??= await client.session.get(
          { sessionID: nativeId },
          requestOptions(),
        );
        if (!messages || stopReason)
          messages = (await openCodeMessages(client, nativeId)).filter(
            (entry) => !initial.has(entry.id),
          );
        const history = opencodeImportedHistory(
          { ...session, tokens: undefined, cost: undefined },
          messages,
        );
        await delivery;
        for (const event of history.events ?? []) await emitSnapshot(event);
        for (const usage of history.usage ?? [])
          await callbacks.onUsage({ ...usage, pricingSource: "opencode-sdk" });
        const idle = messages.findLast((entry) => entry.type === "idle");
        const error = firstString(asRecord(idle).error);
        return {
          status:
            stopReason ??
            (idle?.type === "idle" && idle.outcome === "failed"
              ? "FAILED"
              : idle?.type === "idle" && idle.outcome === "interrupted"
                ? "CANCELLED"
                : "COMPLETED"),
          finalOutput: history.finalOutput,
          ...(error ? { error } : {}),
        };
      } catch (error) {
        return stopReason
          ? { status: stopReason }
          : { status: "FAILED", error: message(error) };
      } finally {
        controller.abort();
        executionController.abort();
        await Promise.allSettled([events, polling]);
        await delivery;
        await cleanup();
      }
    })();
    return {
      nativeId,
      completion,
      async interrupt(reason) {
        stopReason = reason;
        await client.session.interrupt(
          { sessionID: nativeId },
          requestOptions(),
        );
        executionController.abort();
      },
      async steer(prompt, attachments) {
        await send(prompt, attachments, true);
      },
      async answer(id, answers) {
        if (resolvedRequests.has(id)) return;
        const request = pending.get(id);
        if (!request) throw new Error("OpenCode request is no longer pending");
        await request.ready;
        try {
          if (request.kind === "form")
            await client.session.form.reply(
              {
                sessionID: nativeId,
                formID: id,
                answer: runFormAnswers(request.fields, answers),
              },
              requestOptions(),
            );
          else
            await client.permission.reply(
              {
                sessionID: nativeId,
                requestID: id,
                decision: permissionDecision(answers),
              },
              requestOptions(),
            );
          await settle(id, "ANSWERED", answers);
        } catch (error) {
          if (resolvedRequests.has(id)) return;
          if (request.kind === "form") {
            const detail = await client.session.form
              .get({ sessionID: nativeId, formID: id }, requestOptions())
              .catch(() => undefined);
            if (detail?.state.status === "answered") {
              await settle(
                id,
                "ANSWERED",
                Object.fromEntries(
                  Object.entries(detail.state.answer).map(([key, value]) => [
                    key,
                    { value },
                  ]),
                ),
              );
              return;
            }
            if (detail?.state.status === "cancelled") {
              await settle(id, "CANCELLED");
              return;
            }
          }
          await callbacks.onQuestionResolved?.(id, {
            status: "PENDING",
            error: message(error),
          });
          throw error;
        }
      },
      async cancelQuestion(id) {
        const request = pending.get(id);
        if (!request) return;
        if (request?.kind !== "form")
          throw new Error("Only OpenCode forms can be cancelled");
        await client.session.form.cancel(
          { sessionID: nativeId, formID: id },
          requestOptions(),
        );
        await settle(id, "CANCELLED");
      },
    };
  }

  async delete(nativeId: string, cwd: string): Promise<void> {
    const { client } = await this.runtime.client();
    const session = await client.session.get(
      { sessionID: nativeId },
      requestOptions(),
    );
    if (resolve(session.location.directory) !== resolve(cwd))
      throw new Error("OpenCode session belongs to a different worktree");
    await client.session.remove({ sessionID: nativeId }, requestOptions());
    this.hydrationCache.delete(nativeId);
  }
  private async migrationReady(client: OpenCodeClient): Promise<void> {
    const migration = await client.migration.v1.status(requestOptions());
    if (migration.status === "error")
      throw new Error(`OpenCode history migration failed: ${migration.error}`);
    if (migration.status !== "completed")
      throw new Error(
        "OpenCode history migration is pending; history sync will retry when migration completes",
      );
  }
  async discover(
    worktrees: ProviderImportWorktree[],
  ): Promise<ProviderImportedRun[]> {
    const { client } = await this.runtime.client();
    await this.migrationReady(client);
    const clients = [
      client,
      ...(
        await Promise.all(
          [...this.isolated].map((runtime) =>
            runtime
              .client()
              .then(({ client }) => client)
              .catch(() => undefined),
          ),
        )
      ).filter((client): client is OpenCodeClient => !!client),
    ];
    const shared = await sharedOpenCodeClient().catch(() => undefined);
    if (shared) clients.push(shared);
    const active = new Set<string>();
    const activity = await Promise.allSettled(
      clients.map((client) => client.session.active(requestOptions())),
    );
    if (activity[0]?.status === "rejected") throw activity[0].reason;
    for (const result of activity)
      if (result.status === "fulfilled")
        for (const id of Object.keys(result.value)) active.add(id);
    const results: ProviderImportedRun[] = [];
    const failures: string[] = [];
    let hydrated = 0;
    for (const worktree of worktrees) {
      const sessions = await paginated((cursor) =>
        client.session.list(
          {
            directory: worktree.folder,
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : { order: "asc" }),
          },
          requestOptions(),
        ),
      );
      for (const session of sessions) {
        if (resolve(session.location.directory) !== resolve(worktree.folder))
          continue;
        const key = JSON.stringify([
          session.time.updated,
          session.tokens,
          session.cost,
          session.model,
          session.outcome,
        ]);
        if (active.has(session.id)) this.hydrationCache.delete(session.id);
        const cached = this.hydrationCache.get(session.id);
        let history: Partial<ProviderImportedRun> = {};
        try {
          history =
            cached?.key === key
              ? cached.history
              : opencodeImportedHistory(
                  session,
                  await openCodeMessages(client, session.id),
                );
          if (!active.has(session.id))
            this.hydrationCache.set(session.id, { key, history });
          hydrated++;
        } catch (error) {
          failures.push(`${session.id}: ${message(error)}`);
        }
        results.push({
          nativeId: session.id,
          worktreeId: worktree.id,
          ...history,
          status: active.has(session.id)
            ? "IN_PROGRESS"
            : session.outcome === "failed"
              ? "FAILED"
              : session.outcome === "interrupted"
                ? "CANCELLED"
                : (history.status ?? "COMPLETED"),
          kind: history.kind ?? (session.agent === "plan" ? "PLAN" : "SESSION"),
          archived: !!session.time.archived,
          branch: worktree.branch ?? undefined,
          estimatedCost: session.cost,
          pricingSource: "opencode-history",
          createdAt: opencodeTimestamp(session.time.created),
          updatedAt: opencodeTimestamp(session.time.updated),
          rawMetadata: session,
        });
      }
    }
    if (failures.length) {
      const error = `OpenCode history unavailable for ${failures.length} sessions: ${failures.slice(0, 3).join("; ")}`;
      if (!hydrated) throw new Error(error);
      console.warn(error);
    }
    return results;
  }
  async close(): Promise<void> {
    await Promise.all([
      this.runtime.close(),
      ...[...this.isolated].map((runtime) => runtime.close()),
    ]);
    this.isolated.clear();
  }
}
