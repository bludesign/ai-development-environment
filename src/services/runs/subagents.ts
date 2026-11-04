import { createHash } from "node:crypto";
import type { Prisma, RunSubagentMessage } from "@/generated/prisma/client";
import {
  runMetadataRecord,
  type RunSubagentSnapshot,
} from "@ai-development-environment/agent-contract/runs";

const record = runMetadataRecord;
const text = (value: unknown, limit = 500_000): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;
const date = (value: unknown): Date | undefined => {
  const parsed = typeof value === "string" ? new Date(value) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined;
};
const key = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function status(value: unknown): string | undefined {
  const name = text(value, 100)?.toUpperCase();
  if (["COMPLETED", "COMPLETE", "SUCCESS", "DONE"].includes(name ?? ""))
    return "COMPLETED";
  if (["FAILED", "ERROR"].includes(name ?? "")) return "FAILED";
  if (["CANCELLED", "CANCELED", "STOPPED", "KILLED"].includes(name ?? ""))
    return "CANCELLED";
  if (["RUNNING", "IN_PROGRESS", "STARTED"].includes(name ?? ""))
    return "RUNNING";
  return undefined;
}

/** Child snapshots never replace journal events, root results, or root accounting. */
export async function syncRunSubagents(
  transaction: Prisma.TransactionClient,
  runId: string,
  attemptId: string,
  snapshots: RunSubagentSnapshot[],
  historical = true,
): Promise<boolean> {
  let changed = false;
  for (const snapshot of snapshots) {
    const nativeId = text(snapshot.nativeId, 500);
    if (!nativeId) throw new Error("Subagent native ID is required");
    const id = key(attemptId, nativeId);
    const previous = await transaction.runSubagent.findUnique({
      where: { id },
    });
    const digest = historical ? key(JSON.stringify(snapshot)) : undefined;
    if (digest && previous?.snapshotDigest === digest) continue;
    const incomingStatus = status(snapshot.status);
    const nativeRunId = text(snapshot.nativeRunId, 500);
    const staleRun = Boolean(
      previous?.nativeRunId &&
      nativeRunId &&
      nativeRunId < previous.nativeRunId,
    );
    // SDK history can lag a newly resumed task and omit the live execution id.
    // Its previous end_turn must not finish the newer execution.
    const stale =
      staleRun ||
      Boolean(
        historical &&
        previous?.nativeRunId &&
        !nativeRunId &&
        previous.status === "RUNNING" &&
        incomingStatus &&
        terminal.has(incomingStatus) &&
        (!date(snapshot.finishedAt) ||
          !previous.startedAt ||
          date(snapshot.finishedAt)! < previous.startedAt),
      );
    const resumed = Boolean(
      previous &&
      incomingStatus === "RUNNING" &&
      !stale &&
      ((nativeRunId && nativeRunId !== previous.nativeRunId) ||
        (!nativeRunId &&
          !historical &&
          snapshot.startedAt &&
          date(snapshot.startedAt) &&
          (!previous.finishedAt ||
            date(snapshot.startedAt)! > previous.finishedAt))),
    );
    const nextStatus = stale
      ? undefined
      : previous &&
          terminal.has(previous.status) &&
          incomingStatus === "RUNNING" &&
          !resumed
        ? previous.status
        : incomingStatus;
    if (
      !["AVAILABLE", "PARTIAL", "UNAVAILABLE"].includes(
        snapshot.transcriptStatus,
      )
    )
      throw new Error("Subagent transcript status is invalid");
    const hasCachedMessages =
      snapshot.transcriptStatus === "UNAVAILABLE" && previous
        ? (await transaction.runSubagentMessage.count({
            where: { subagentId: id },
          })) > 0
        : false;
    const data = {
      nativeRunId: stale ? undefined : nativeRunId,
      parentNativeId: text(snapshot.parentNativeId, 500),
      toolUseId: text(snapshot.toolUseId, 500),
      label: text(snapshot.label, 2_000),
      agentType: text(snapshot.agentType, 200),
      status: nextStatus,
      prompt: text(snapshot.prompt),
      finalOutput: stale
        ? undefined
        : resumed
          ? null
          : text(snapshot.finalOutput),
      startedAt:
        historical && previous?.nativeRunId
          ? undefined
          : date(snapshot.startedAt),
      finishedAt: stale
        ? undefined
        : resumed
          ? null
          : date(snapshot.finishedAt),
      transcriptStatus:
        !historical && previous?.transcriptStatus === "AVAILABLE"
          ? "AVAILABLE"
          : hasCachedMessages
            ? "PARTIAL"
            : snapshot.transcriptStatus,
      transcriptError: historical
        ? (text(snapshot.transcriptError, 2_000) ?? null)
        : undefined,
      snapshotDigest: digest,
    };
    await transaction.runSubagent.upsert({
      where: { id },
      create: {
        ...data,
        id,
        runId,
        attemptId,
        nativeId,
        label: data.label ?? nativeId,
        status: nextStatus ?? "UNKNOWN",
      },
      update: data,
    });
    changed = true;
    if (!snapshot.messages?.length) continue;
    const incoming = new Map<
      string,
      { nativeId: string; rawJson: string; createdAt?: Date }
    >();
    for (const message of snapshot.messages) {
      const nativeMessageId = text(message.nativeId, 1_000);
      const raw = record(message.raw);
      if (!nativeMessageId || !["user", "assistant"].includes(String(raw.type)))
        continue;
      incoming.set(key(id, nativeMessageId), {
        nativeId: nativeMessageId,
        rawJson: JSON.stringify(raw),
        createdAt: date(message.createdAt) ?? date(raw.timestamp),
      });
    }
    const existing = await transaction.runSubagentMessage.findMany({
      where: { subagentId: id, id: { in: [...incoming.keys()] } },
      select: { id: true, sequence: true, rawJson: true, createdAt: true },
    });
    const byId = new Map(existing.map((message) => [message.id, message]));
    let sequence = historical
      ? -1
      : ((
          await transaction.runSubagentMessage.aggregate({
            where: { subagentId: id },
            _max: { sequence: true },
          })
        )._max.sequence ?? -1);
    const fresh: Prisma.RunSubagentMessageCreateManyInput[] = [];
    for (const [messageId, message] of incoming) {
      const { rawJson, createdAt } = message;
      const current = byId.get(messageId);
      const messageSequence = historical
        ? ++sequence
        : (current?.sequence ?? ++sequence);
      if (current) {
        if (
          current.rawJson !== rawJson ||
          current.sequence !== messageSequence ||
          (createdAt && current.createdAt.getTime() !== createdAt.getTime())
        ) {
          await transaction.runSubagentMessage.update({
            where: { id: messageId },
            data: { rawJson, createdAt, sequence: messageSequence },
          });
        }
      } else {
        fresh.push({
          id: messageId,
          subagentId: id,
          nativeId: message.nativeId,
          sequence: messageSequence,
          rawJson,
          createdAt: createdAt ?? new Date(),
        });
      }
    }
    if (fresh.length)
      await transaction.runSubagentMessage.createMany({ data: fresh });
  }
  return changed;
}

/** Project lifecycle records first, since child messages may precede their task event. */
export async function projectClaudeSubagents(
  transaction: Prisma.TransactionClient,
  runId: string,
  attemptId: string,
  events: Array<{ id: string; raw?: unknown; createdAt?: string | null }>,
): Promise<void> {
  const relevant = events.some(({ raw: value }) => {
    const raw = record(value);
    return (
      raw.agent_id ||
      raw.parent_tool_use_id ||
      (raw.type === "system" && String(raw.subtype).startsWith("task_"))
    );
  });
  if (!relevant) return;
  const attempt = await transaction.runAttempt.findUnique({
    where: { id: attemptId },
  });
  if (!attempt || attempt.runId !== runId)
    throw new Error("Run attempt not found for this run");
  const messageEvents = new Map(events.map((event) => [event.id, event]));
  for (const event of events) {
    const raw = record(event.raw);
    if (raw.type !== "system" || !String(raw.subtype).startsWith("task_"))
      continue;
    const nativeId = text(raw.task_id, 500);
    if (!nativeId || (raw.task_type && raw.task_type !== "local_agent"))
      continue;
    const subtype = String(raw.subtype);
    const patch = record(raw.patch);
    const previous = await transaction.runSubagent.findUnique({
      where: { id: key(attemptId, nativeId) },
    });
    const started = events
      .map((value) => record(value.raw))
      .find(
        (value) =>
          value.subtype === "task_started" && value.task_id === nativeId,
      );
    // Shell, MCP, and workflow tasks share the task_* envelope with agents.
    // A typeless progress/notification frame alone is not evidence of an agent.
    const agentEvidence =
      previous ||
      raw.task_type === "local_agent" ||
      raw.subagent_type ||
      started?.task_type === "local_agent" ||
      started?.subagent_type ||
      events.some((value) => record(value.raw).agent_id === nativeId);
    if (!agentEvidence) continue;
    const nativeRunId = text(raw.run_id, 500);
    if (
      nativeRunId &&
      previous?.nativeRunId &&
      nativeRunId < previous.nativeRunId
    )
      continue;
    const incomingStatus =
      status(raw.status ?? patch.status) ??
      (subtype === "task_started" || subtype === "task_progress"
        ? "RUNNING"
        : undefined);
    await syncRunSubagents(
      transaction,
      runId,
      attemptId,
      [
        {
          nativeId,
          nativeRunId,
          parentNativeId: text(raw.parent_task_id ?? raw.parent_agent_id, 500),
          toolUseId: text(raw.tool_use_id, 500),
          label: text(
            subtype === "task_started" ? raw.description : patch.description,
            2_000,
          ),
          agentType: text(raw.subagent_type ?? patch.subagent_type, 200),
          status: incomingStatus,
          prompt: text(raw.prompt ?? patch.prompt),
          finalOutput:
            subtype === "task_notification"
              ? text(raw.summary)
              : text(patch.result),
          startedAt:
            subtype === "task_started"
              ? (event.createdAt ?? undefined)
              : undefined,
          finishedAt:
            incomingStatus && terminal.has(incomingStatus)
              ? (event.createdAt ?? undefined)
              : undefined,
          transcriptStatus: "PARTIAL",
        },
      ],
      false,
    );
    const toolUseId = text(raw.tool_use_id, 500);
    if (subtype === "task_started" && toolUseId) {
      // Reconcile messages uploaded in a previous batch before the spawn frame
      // supplied their agent id. The journal remains the source of those rows.
      const waiting = await transaction.runEvent.findMany({
        where: {
          runId,
          attemptId,
          type: { in: ["USER", "ASSISTANT"] },
          rawJson: { contains: toolUseId },
        },
        orderBy: { sequence: "asc" },
      });
      for (const value of waiting) {
        const candidate = record(value.rawJson);
        if (candidate.parent_tool_use_id !== toolUseId) continue;
        messageEvents.set(value.id, {
          id: value.id,
          raw: candidate,
          createdAt: value.createdAt.toISOString(),
        });
      }
    }
  }
  const children = new Map<string, RunSubagentSnapshot>();
  for (const event of messageEvents.values()) {
    const raw = record(event.raw);
    if (!["user", "assistant"].includes(String(raw.type))) continue;
    let nativeId = text(raw.agent_id, 500);
    const toolUseId = text(raw.parent_tool_use_id, 500);
    if (!nativeId && toolUseId) {
      nativeId = (
        await transaction.runSubagent.findFirst({
          where: { attemptId, toolUseId },
        })
      )?.nativeId;
    }
    if (!nativeId) continue;
    const child = children.get(nativeId) ?? {
      nativeId,
      parentNativeId: text(raw.parent_agent_id, 500),
      toolUseId,
      transcriptStatus: "PARTIAL" as const,
      messages: [],
    };
    child.messages!.push({
      nativeId:
        text(raw.uuid, 1_000) ??
        text(record(raw.message).id, 1_000) ??
        event.id,
      raw,
      createdAt: text(raw.timestamp, 100) ?? event.createdAt ?? undefined,
    });
    children.set(nativeId, child);
  }
  await syncRunSubagents(
    transaction,
    runId,
    attemptId,
    [...children.values()],
    false,
  );
}

/** Adapt complete provider messages to the existing provider-aware activity renderer. */
export function subagentMessageEvents(
  message: RunSubagentMessage,
  runId: string,
  attemptId: string,
) {
  const raw = record(message.rawJson);
  const envelope = record(raw.message);
  const content =
    typeof envelope.content === "string"
      ? [{ type: "text", text: envelope.content }]
      : Array.isArray(envelope.content)
        ? envelope.content
        : [];
  return content.map((value, index) => {
    const block = record(value);
    const detailMarkdown =
      block.type === "text" ? (text(block.text) ?? null) : null;
    return {
      id: `${message.id}:${index}`,
      runId,
      attemptId,
      sequence: message.sequence * 1_000 + index,
      type: String(raw.type).toUpperCase(),
      summary: (
        detailMarkdown ??
        text(block.name, 2_000) ??
        (block.type === "tool_result"
          ? "Tool result"
          : text(block.type, 100)) ??
        "Claude message"
      ).slice(0, 2_000),
      detailMarkdown,
      rawJson: JSON.stringify({
        ...raw,
        message: { ...envelope, content: [block] },
      }),
      createdAt: message.createdAt,
      supersededAt: null,
    };
  });
}
