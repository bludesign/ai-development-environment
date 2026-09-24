import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { copyFile, open, rm, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  DSYMS_ARTIFACT_KIND,
  IOS_BUILD_JOB_KIND,
} from "@ai-development-environment/agent-contract/builds";
import {
  CRASH_SYMBOLICATE_JOB_KIND,
  CRASH_SYMBOLICATION_TIMEOUT_SECONDS,
  parseCrashSymbolicationResult,
  type CrashSymbolicationLookup,
  type CrashSymbolicationPayload,
} from "@ai-development-environment/agent-contract/crashes";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  agentOnlineWindowMs,
  type AgentControlService,
} from "@/services/agent-control/agent-control.service";
import {
  CRASH_REPORTS_CHANGED_TOPIC,
  DSYMS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control/event-bus";
import type { PollingService } from "@/services/polling";

import {
  CRASH_REPORT_MAX_BYTES,
  DSYM_RESUMABLE_MAX_BYTES,
  DSYM_UPLOAD_CHUNK_BYTES,
  PayloadTooLargeError,
  crashDataPath,
  dsymFolder,
  ensureCrashDataFolder,
  fileSha256,
  removeCrashData,
  writeCrashBytes,
} from "./crash-store";
import { DsymIndexError, extractDsymArchive } from "./dsym-index";
import { detectAndParse } from "./parsers";
import {
  crashSignature,
  mergeSymbolication,
  renderCrashText,
  settledStatus,
  symbolicationCandidates,
} from "./symbolication";
import {
  EMPTY_SYMBOLICATION,
  type CrashReportSource,
  type CrashReportStatus,
  type CrashSymbolication,
  type DsymSource,
  type NormalizedCrash,
} from "./types";

export const CRASH_SETTINGS_ID = "default";
export const CRASH_POLLING_OPERATION_ID = "server:crash-symbolication";
const TICK_SECONDS = 60;
/** Attempts at one symbolication generation before the crash is marked failed. */
const MAX_ATTEMPTS = 3;
/** Crashes dispatched per tick, so a dSYM upload cannot flood the agents. */
const DISPATCH_PER_TICK = 25;
/** Build dSYM imports per tick; each one pulls a zip from an agent. */
const BUILD_IMPORTS_PER_TICK = 2;
const MAX_BUILD_IMPORT_ATTEMPTS = 5;
/** A job still queued this long on an agent that went offline is abandoned. */
const STALE_QUEUED_MS = 10 * 60_000;
const STALE_UPLOAD_MS = 24 * 60 * 60_000;
const FINISHED_JOB_RETENTION_MS = 24 * 60 * 60_000;
const MAX_PAGE = 200;

type ChangeReason =
  "CREATED" | "UPDATED" | "DELETED" | "SYMBOLICATED" | "SETTINGS";

export type CrashUploader = {
  source: CrashReportSource;
  uploadedBy: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  clientIp: string | null;
};

export type DsymUploader = {
  source: DsymSource;
  uploadedBy: string | null;
  apiKeyId: string | null;
  /** Who may continue a resumable upload: `user:<id>` or `api-key:<id>`. */
  ownerKey: string | null;
};

export type DsymMetadata = {
  buildId?: string | null;
  url?: string | null;
  projectName?: string | null;
};

export class CrashRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "INVALID_REQUEST",
  ) {
    super(message);
    this.name = "CrashRequestError";
  }
}

type CrashRow = Prisma.CrashReportGetPayload<{
  include: { binaryImages: true };
}>;

export type CrashReportFilter = {
  search?: string | null;
  status?: CrashReportStatus | null;
  bundleId?: string | null;
  appVersion?: string | null;
  signature?: string | null;
};

export type DsymFilter = {
  search?: string | null;
  buildId?: string | null;
  projectName?: string | null;
  uuid?: string | null;
};

type Cursor = { createdAt: string; id: string };

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
  ).toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Cursor;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.createdAt === "string" &&
      Number.isFinite(Date.parse(parsed.createdAt))
    ) {
      return parsed;
    }
  } catch {
    // Reported below.
  }
  throw new CrashRequestError("Invalid cursor");
}

function olderThan(cursor: Cursor) {
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: cursor.id } },
    ],
  };
}

function pageSize(value: number | null | undefined): number {
  return Math.max(1, Math.min(value ?? 50, MAX_PAGE));
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizedCrash(row: { normalizedJson: string }) {
  return parseJson<NormalizedCrash | null>(row.normalizedJson, null);
}

export function crashSymbolication(row: {
  symbolicationJson: string;
}): CrashSymbolication {
  const value = parseJson<CrashSymbolication>(
    row.symbolicationJson,
    EMPTY_SYMBOLICATION,
  );
  return value && typeof value === "object" && value.images
    ? value
    : EMPTY_SYMBOLICATION;
}

function optionalText(
  value: unknown,
  name: string,
  maximum: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new CrashRequestError(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maximum) {
    throw new CrashRequestError(
      `${name} must be at most ${maximum} characters`,
    );
  }
  return trimmed;
}

/** Validates the optional values a dSYM upload may carry. */
export function parseDsymMetadata(input: {
  buildId?: unknown;
  url?: unknown;
  projectName?: unknown;
}): Required<DsymMetadata> {
  const url = optionalText(input.url, "url", 2_000);
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CrashRequestError("url must be an absolute URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new CrashRequestError("url must use http or https");
    }
  }
  return {
    buildId: optionalText(input.buildId, "buildId", 200),
    url,
    projectName: optionalText(input.projectName, "projectName", 200),
  };
}

function reportExtension(format: string, filename: string | null): string {
  const extension = filename ? extname(filename).toLowerCase() : "";
  if ([".ips", ".crash", ".json", ".txt"].includes(extension)) return extension;
  return format === "CRASH" ? ".crash" : format === "IPS" ? ".ips" : ".json";
}

function crashSearchText(crash: NormalizedCrash, title: string): string {
  return [
    crash.appName,
    crash.bundleId,
    crash.appVersion,
    crash.buildVersion,
    crash.osVersion,
    crash.deviceModel,
    crash.exceptionType,
    crash.signal,
    crash.exceptionReason,
    crash.incidentId,
    title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .slice(0, 4_000);
}

function isOnline(agent: {
  lastSeenAt: Date | null;
  disconnectedAt: Date | null;
  heartbeatIntervalSeconds: number | null;
}) {
  return (
    agent.lastSeenAt !== null &&
    agent.disconnectedAt === null &&
    Date.now() - agent.lastSeenAt.getTime() <= agentOnlineWindowMs(agent)
  );
}

function canSymbolicate(agent: { capabilitiesJson: string }) {
  return parseJson<unknown[]>(agent.capabilitiesJson, []).includes(
    CRASH_SYMBOLICATE_JOB_KIND,
  );
}

export class CrashesService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;

  constructor(
    private readonly agentControl: AgentControlService,
    private readonly polling?: PollingService,
  ) {
    this.agentControl.registerCompletionHandler(
      CRASH_SYMBOLICATE_JOB_KIND,
      (job) => this.projectSymbolication(job),
    );
    // An observer rather than a handler: `ios.build.run` already has one, and
    // observers run after it has committed the build's artifacts.
    this.agentControl.registerCompletionObserver(async (job) => {
      if (job.kind === IOS_BUILD_JOB_KIND && job.status === "SUCCEEDED") {
        await this.queueBuildDsyms(job.id);
      }
    });
    this.agentControl.registerConnectionHandler(async () => this.changed());
    this.polling?.register({
      id: CRASH_POLLING_OPERATION_ID,
      kind: "CRASH_SYMBOLICATION",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: TICK_SECONDS,
      details: {},
    });
  }

  startRuntime(): void {
    if (process.env.CRASH_RUNTIME_DISABLED === "1") return;
    queueMicrotask(() => this.changed());
  }

  /** Runs the reconciliation soon, coalescing requests that arrive meanwhile. */
  changed(): void {
    if (process.env.CRASH_RUNTIME_DISABLED === "1") return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = this.reconcileWithReporting().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        this.changed();
        return;
      }
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed(), TICK_SECONDS * 1_000);
    this.timer.unref?.();
    this.polling?.schedule(
      CRASH_POLLING_OPERATION_ID,
      new Date(Date.now() + TICK_SECONDS * 1_000),
    );
  }

  private async reconcileWithReporting(): Promise<void> {
    try {
      if (this.polling) {
        await this.polling.run(CRASH_POLLING_OPERATION_ID, () =>
          this.reconcile(),
        );
      } else {
        await this.reconcile();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.error("Crash symbolication reconciliation failed:", error);
      }
    }
  }

  private publishCrashes(reason: ChangeReason, ids: string[]): void {
    agentEventBus.publish(CRASH_REPORTS_CHANGED_TOPIC, { reason, ids });
  }

  private publishDsyms(reason: ChangeReason, ids: string[]): void {
    agentEventBus.publish(DSYMS_CHANGED_TOPIC, { reason, ids });
  }

  subscribeCrashReports() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      CRASH_REPORTS_CHANGED_TOPIC,
    );
  }

  subscribeDsyms() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      DSYMS_CHANGED_TOPIC,
    );
  }

  // Settings

  async settings() {
    const prisma = await getPrismaClient();
    return prisma.crashSettings.upsert({
      where: { id: CRASH_SETTINGS_ID },
      create: { id: CRASH_SETTINGS_ID },
      update: {},
      include: { symbolicationAgent: true },
    });
  }

  async updateSettings(input: {
    collectionEnabled?: boolean | null;
    symbolicationAgentId?: string | null;
    retentionDays?: number | null;
    /** Null keeps dSYMs until they are deleted. */
    dsymRetentionDays?: number | null;
  }) {
    const data: Prisma.CrashSettingsUncheckedUpdateInput = {};
    if (typeof input.collectionEnabled === "boolean") {
      data.collectionEnabled = input.collectionEnabled;
    }
    if (input.symbolicationAgentId !== undefined) {
      if (input.symbolicationAgentId) {
        const prisma = await getPrismaClient();
        const agent = await prisma.agent.findUnique({
          where: { id: input.symbolicationAgentId },
        });
        if (!agent) throw new CrashRequestError("The agent does not exist");
        if (!canSymbolicate(agent)) {
          throw new CrashRequestError(
            "The agent cannot symbolicate crashes; choose a macOS agent with Xcode",
          );
        }
      }
      data.symbolicationAgentId = input.symbolicationAgentId || null;
    }
    const days = (value: number, name: string) => {
      if (!Number.isInteger(value) || value < 1 || value > 3_650) {
        throw new CrashRequestError(`${name} must be between 1 and 3650 days`);
      }
      return value;
    };
    if (typeof input.retentionDays === "number") {
      data.retentionDays = days(input.retentionDays, "retentionDays");
    }
    if (input.dsymRetentionDays === null) data.dsymRetentionDays = null;
    else if (typeof input.dsymRetentionDays === "number") {
      data.dsymRetentionDays = days(
        input.dsymRetentionDays,
        "dsymRetentionDays",
      );
    }
    await this.settings();
    const prisma = await getPrismaClient();
    const settings = await prisma.crashSettings.update({
      where: { id: CRASH_SETTINGS_ID },
      data,
      include: { symbolicationAgent: true },
    });
    this.publishCrashes("SETTINGS", []);
    this.changed();
    return settings;
  }

  /** Online agents that advertise crash symbolication. */
  async symbolicationAgents() {
    const prisma = await getPrismaClient();
    const agents = await prisma.agent.findMany({ orderBy: { name: "asc" } });
    return agents
      .filter(canSymbolicate)
      .map((agent) => ({ ...agent, online: isOnline(agent) }));
  }

  // Crash ingestion

  async ingestCrashReport(input: {
    bytes: Uint8Array;
    filename: string | null;
    uploader: CrashUploader;
  }): Promise<{ crashes: CrashRow[]; duplicate: boolean }> {
    if (input.bytes.byteLength > CRASH_REPORT_MAX_BYTES) {
      throw new PayloadTooLargeError("Crash reports may be at most 5 MiB");
    }
    const parsed = detectAndParse(input.bytes);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const prisma = await getPrismaClient();
    const existing = await prisma.crashReport.findMany({
      where: { sha256 },
      include: { binaryImages: true },
      orderBy: { payloadIndex: "asc" },
    });
    if (existing.length === parsed.length) {
      return { crashes: existing, duplicate: true };
    }
    const known = new Set(existing.map((crash) => crash.payloadIndex));
    const firstId = randomUUID();
    const storagePath =
      existing[0]?.storagePath ??
      `reports/${firstId}${reportExtension(parsed[0]!.format, input.filename)}`;
    if (!existing.length) await writeCrashBytes(storagePath, input.bytes);
    const filename =
      optionalText(input.filename, "filename", 255) ?? basename(storagePath);
    const created: string[] = [];
    try {
      for (const [index, crash] of parsed.entries()) {
        if (known.has(index)) continue;
        const id = index === 0 && !existing.length ? firstId : randomUUID();
        const { signature, title } = crashSignature(crash);
        const candidates = symbolicationCandidates(crash);
        await prisma.crashReport.create({
          data: {
            id,
            format: crash.format,
            source: input.uploader.source,
            uploadedBy: input.uploader.uploadedBy,
            apiKeyId: input.uploader.apiKeyId,
            apiKeyName: input.uploader.apiKeyName,
            clientIp: input.uploader.clientIp,
            filename,
            storagePath,
            sha256,
            payloadIndex: index,
            sizeBytes: input.bytes.byteLength,
            incidentId: crash.incidentId,
            appName: crash.appName,
            bundleId: crash.bundleId,
            appVersion: crash.appVersion,
            buildVersion: crash.buildVersion,
            osVersion: crash.osVersion,
            deviceModel: crash.deviceModel,
            arch: crash.arch,
            exceptionType: crash.exceptionType,
            exceptionCodes: crash.exceptionCodes,
            signal: crash.signal,
            terminationReason: crash.terminationReason,
            crashedThread: crash.crashedThread,
            crashedAt: crash.crashedAt ? new Date(crash.crashedAt) : null,
            signature,
            signatureTitle: title,
            status: "PENDING",
            normalizedJson: JSON.stringify(crash),
            searchText: crashSearchText(crash, title),
            binaryImages: {
              create: crash.images
                .filter((image) => image.isApp && image.uuid)
                .map((image) => ({
                  id: randomUUID(),
                  imageIndex: image.index,
                  uuid: image.uuid!,
                  name: image.name,
                  arch: image.arch,
                  loadAddress: image.base,
                  path: image.path,
                  frameCount: candidates.get(image.index)?.frames ?? 0,
                })),
            },
          },
        });
        created.push(id);
      }
    } catch (error) {
      if (!existing.length && !created.length) {
        await removeCrashData(storagePath);
      }
      throw error;
    }
    for (const id of created) await this.prepare(id);
    this.publishCrashes("CREATED", created);
    const crashes = await prisma.crashReport.findMany({
      where: { sha256 },
      include: { binaryImages: true },
      orderBy: { payloadIndex: "asc" },
    });
    return { crashes, duplicate: false };
  }

  /**
   * Matches a crash's images to the newest ready dSYM with the same UUID and
   * either settles the crash or dispatches the offsets still unnamed.
   */
  private async prepare(crashId: string, reason?: string): Promise<void> {
    const prisma = await getPrismaClient();
    const crash = await prisma.crashReport.findUnique({
      where: { id: crashId },
      include: { binaryImages: true },
    });
    if (!crash) return;
    const normalized = normalizedCrash(crash);
    if (!normalized) {
      await prisma.crashReport.update({
        where: { id: crashId },
        data: {
          status: "FAILED",
          statusMessage: "The stored crash report could not be read",
        },
      });
      return;
    }
    const symbolication = crashSymbolication(crash);
    const uuids = [...new Set(crash.binaryImages.map((image) => image.uuid))];
    const slices = uuids.length
      ? await prisma.dsymSlice.findMany({
          where: { uuid: { in: uuids }, dsym: { upload: { status: "READY" } } },
          include: { dsym: true },
          orderBy: { dsym: { createdAt: "desc" } },
        })
      : [];
    const newest = new Map<string, (typeof slices)[number]>();
    for (const slice of slices) {
      if (!newest.has(slice.uuid)) newest.set(slice.uuid, slice);
    }
    for (const image of crash.binaryImages) {
      const dsymId = newest.get(image.uuid)?.dsymId ?? null;
      if (dsymId && image.dsymId !== dsymId) {
        await prisma.crashBinaryImage.update({
          where: { id: image.id },
          data: { dsymId },
        });
      }
    }

    const candidates = symbolicationCandidates(normalized);
    const lookups: CrashSymbolicationLookup[] = [];
    const dsyms = new Map<string, (typeof slices)[number]["dsym"]>();
    for (const { image, offsets } of candidates.values()) {
      const slice = image.uuid ? newest.get(image.uuid) : undefined;
      if (!slice) continue;
      const answered = symbolication.images[slice.uuid];
      const pending = [...offsets].filter(
        (offset) =>
          answered?.dsymId !== slice.dsymId || !(offset in answered.offsets),
      );
      if (!pending.length) continue;
      dsyms.set(slice.dsymId, slice.dsym);
      lookups.push({
        dsymId: slice.dsymId,
        uuid: slice.uuid,
        arch: slice.arch,
        offsets: pending,
      });
    }
    if (!lookups.length) {
      const settled = settledStatus(
        normalized,
        symbolication,
        new Set(newest.keys()),
      );
      await this.settle(crashId, normalized, symbolication, settled);
      return;
    }
    const payload: CrashSymbolicationPayload = {
      crashId,
      dsyms: [...dsyms.values()].map((dsym) => ({
        dsymId: dsym.id,
        sha256: dsym.dwarfSha256,
        sizeBytes: dsym.dwarfSizeBytes,
        binaryName: dsym.binaryName,
        downloadPath: `/api/agent/dsyms/${encodeURIComponent(dsym.id)}/dwarf`,
      })),
      lookups,
    };
    await this.dispatch(crash, payload, reason);
  }

  private async pickAgent(): Promise<string | null> {
    const settings = await this.settings();
    const agents = (await this.symbolicationAgents()).filter(
      (agent) => agent.online,
    );
    const preferred = agents.find(
      (agent) => agent.id === settings.symbolicationAgentId,
    );
    return (preferred ?? agents[0])?.id ?? null;
  }

  private async dispatch(
    crash: CrashRow,
    payload: CrashSymbolicationPayload,
    reason?: string,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    if (crash.attempts >= MAX_ATTEMPTS) {
      await prisma.crashReport.update({
        where: { id: crash.id },
        data: {
          status: "FAILED",
          statusMessage:
            reason ?? crash.statusMessage ?? "Symbolication failed repeatedly",
          jobId: null,
        },
      });
      this.publishCrashes("UPDATED", [crash.id]);
      return;
    }
    const agentId = await this.pickAgent();
    if (!agentId) {
      if (crash.status !== "WAITING_FOR_AGENT") {
        await prisma.crashReport.update({
          where: { id: crash.id },
          data: {
            status: "WAITING_FOR_AGENT",
            statusMessage:
              "Waiting for an online macOS agent with Xcode to symbolicate",
            jobId: null,
          },
        });
        this.publishCrashes("UPDATED", [crash.id]);
      }
      return;
    }
    const attempt = crash.attempts + 1;
    const job = await this.agentControl.createJob({
      agentId,
      kind: CRASH_SYMBOLICATE_JOB_KIND,
      payload,
      idempotencyKey: `crash:symbolicate:${crash.id}:${crash.generation}:${attempt}`,
      timeoutSeconds: CRASH_SYMBOLICATION_TIMEOUT_SECONDS,
      visibility: "SYSTEM",
    });
    await prisma.crashReport.update({
      where: { id: crash.id },
      data: {
        status: "SYMBOLICATING",
        statusMessage: null,
        attempts: attempt,
        jobId: job.id,
        agentId,
      },
    });
    this.publishCrashes("UPDATED", [crash.id]);
  }

  private async settle(
    crashId: string,
    normalized: NormalizedCrash,
    symbolication: CrashSymbolication,
    settled: { status: CrashReportStatus; message: string | null },
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const { signature, title } = crashSignature(normalized, symbolication);
    await prisma.crashReport.update({
      where: { id: crashId },
      data: {
        status: settled.status,
        statusMessage: settled.message,
        signature,
        signatureTitle: title,
        searchText: crashSearchText(normalized, title),
        jobId: null,
        symbolicatedAt: symbolication.symbolicatedAt
          ? new Date(symbolication.symbolicatedAt)
          : undefined,
      },
    });
    this.publishCrashes("UPDATED", [crashId]);
  }

  /**
   * Applies an agent's answer. Idempotent: the agent retries `completeJob` when
   * the call times out, and a retry of a job that is no longer the crash's
   * current one changes nothing.
   */
  async projectSymbolication(job: {
    id: string;
    agentId: string;
    payloadJson: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }): Promise<void> {
    const payload = parseJson<{ crashId?: string }>(job.payloadJson, {});
    if (!payload.crashId) return;
    const prisma = await getPrismaClient();
    const crash = await prisma.crashReport.findUnique({
      where: { id: payload.crashId },
      include: { binaryImages: true },
    });
    if (!crash || crash.jobId !== job.id) return;
    const normalized = normalizedCrash(crash);
    if (!normalized) return;
    if (job.status !== "SUCCEEDED") {
      const message =
        job.error ||
        `Symbolication ${job.status.toLowerCase().replaceAll("_", " ")}`;
      await prisma.crashReport.update({
        where: { id: crash.id },
        data:
          crash.attempts >= MAX_ATTEMPTS
            ? { status: "FAILED", statusMessage: message, jobId: null }
            : {
                status: "WAITING_FOR_AGENT",
                statusMessage: `${message}; retrying`,
                jobId: null,
              },
      });
      this.publishCrashes("UPDATED", [crash.id]);
      if (crash.attempts < MAX_ATTEMPTS) this.changed();
      return;
    }
    let result;
    try {
      result = parseCrashSymbolicationResult(
        parseJson<unknown>(job.resultJson, null),
      );
    } catch (error) {
      await prisma.crashReport.update({
        where: { id: crash.id },
        data: {
          status: "FAILED",
          statusMessage: `The agent returned an invalid result: ${error instanceof Error ? error.message : String(error)}`,
          jobId: null,
        },
      });
      this.publishCrashes("UPDATED", [crash.id]);
      return;
    }
    const merged = mergeSymbolication(crashSymbolication(crash), result, {
      generation: crash.generation,
      agentId: job.agentId,
      at: new Date(),
    });
    await prisma.crashReport.update({
      where: { id: crash.id },
      data: { symbolicationJson: JSON.stringify(merged) },
    });
    const matched = new Set(
      crash.binaryImages
        .filter((image) => image.dsymId)
        .map((image) => image.uuid),
    );
    await this.settle(
      crash.id,
      normalized,
      merged,
      settledStatus(normalized, merged, matched),
    );
  }

  /** Starts over with fresh dSYM matches, keeping nothing from earlier runs. */
  async symbolicate(id: string) {
    const prisma = await getPrismaClient();
    const crash = await prisma.crashReport.findUnique({ where: { id } });
    if (!crash) throw new CrashRequestError("Crash report not found", 404);
    if (crash.jobId) {
      await this.agentControl.cancelJob(crash.jobId).catch(() => null);
    }
    await prisma.crashReport.update({
      where: { id },
      data: {
        status: "PENDING",
        statusMessage: null,
        attempts: 0,
        generation: { increment: 1 },
        jobId: null,
        symbolicationJson: JSON.stringify(EMPTY_SYMBOLICATION),
      },
    });
    await prisma.crashBinaryImage.updateMany({
      where: { crashId: id },
      data: { dsymId: null },
    });
    await this.prepare(id);
    return this.crashReport(id);
  }

  // Crash queries

  async crashReports(
    filter: CrashReportFilter = {},
    first?: number | null,
    after?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const where: Prisma.CrashReportWhereInput = {};
    const search = filter.search?.trim().toLowerCase();
    if (search) where.searchText = { contains: search };
    if (filter.status) where.status = filter.status;
    if (filter.bundleId) where.bundleId = filter.bundleId;
    if (filter.appVersion) where.appVersion = filter.appVersion;
    if (filter.signature) where.signature = filter.signature;
    const cursor = decodeCursor(after);
    const size = pageSize(first);
    const [rows, totalCount, matchingCount] = await Promise.all([
      prisma.crashReport.findMany({
        where: cursor ? { AND: [where, olderThan(cursor)] } : where,
        include: { binaryImages: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: size + 1,
      }),
      prisma.crashReport.count(),
      prisma.crashReport.count({ where }),
    ]);
    const nodes = rows.slice(0, size);
    return {
      nodes,
      nextCursor:
        rows.length > size ? encodeCursor(nodes[nodes.length - 1]!) : null,
      totalCount,
      matchingCount,
    };
  }

  async crashReport(id: string) {
    const prisma = await getPrismaClient();
    return prisma.crashReport.findUnique({
      where: { id },
      include: { binaryImages: true },
    });
  }

  async similarCrashes(
    crash: { id: string; signature: string },
    first?: number | null,
  ) {
    const prisma = await getPrismaClient();
    return prisma.crashReport.findMany({
      where: { signature: crash.signature, id: { not: crash.id } },
      include: { binaryImages: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize(first ?? 20),
    });
  }

  async similarCrashCount(crash: { id: string; signature: string }) {
    const prisma = await getPrismaClient();
    return prisma.crashReport.count({
      where: { signature: crash.signature, id: { not: crash.id } },
    });
  }

  async dsymsByIds(ids: string[]) {
    if (!ids.length) return [];
    const prisma = await getPrismaClient();
    return prisma.dsym.findMany({
      where: { id: { in: ids } },
      include: { upload: true, slices: true },
    });
  }

  async crashFacets() {
    const prisma = await getPrismaClient();
    const apps = await prisma.crashReport.groupBy({
      by: ["bundleId", "appName"],
      _count: { _all: true },
      orderBy: { bundleId: "asc" },
    });
    const versions = await prisma.crashReport.groupBy({
      by: ["appVersion"],
      _count: { _all: true },
      orderBy: { appVersion: "desc" },
    });
    return {
      apps: apps
        .filter((app) => app.bundleId)
        .map((app) => ({
          bundleId: app.bundleId!,
          appName: app.appName,
          count: app._count._all,
        })),
      appVersions: versions
        .map((version) => version.appVersion)
        .filter((value): value is string => Boolean(value)),
    };
  }

  async deleteCrashReports(ids: string[]) {
    if (!ids.length) return 0;
    const prisma = await getPrismaClient();
    const crashes = await prisma.crashReport.findMany({
      where: { id: { in: ids } },
      select: { id: true, jobId: true, storagePath: true },
    });
    for (const crash of crashes) {
      if (crash.jobId) {
        await this.agentControl.cancelJob(crash.jobId).catch(() => null);
      }
    }
    const deleted = await prisma.crashReport.deleteMany({
      where: { id: { in: crashes.map((crash) => crash.id) } },
    });
    await this.removeOrphanReportFiles(
      crashes.map((crash) => crash.storagePath),
    );
    this.publishCrashes(
      "DELETED",
      crashes.map((crash) => crash.id),
    );
    return deleted.count;
  }

  /** Deletes stored reports no remaining crash row still points at. */
  private async removeOrphanReportFiles(paths: string[]) {
    const prisma = await getPrismaClient();
    for (const path of new Set(paths)) {
      const remaining = await prisma.crashReport.count({
        where: { storagePath: path },
      });
      if (!remaining) await removeCrashData(path);
    }
  }

  async crashDownload(id: string, variant: "ORIGINAL" | "SYMBOLICATED") {
    const crash = await this.crashReport(id);
    if (!crash) return null;
    const stem = (crash.filename || crash.id).replace(/\.[^.]+$/, "");
    if (variant === "SYMBOLICATED") {
      const normalized = normalizedCrash(crash);
      if (!normalized) return null;
      return {
        filename: `${stem}-symbolicated.crash`,
        contentType: "text/plain; charset=utf-8",
        body: renderCrashText(normalized, crashSymbolication(crash)),
      };
    }
    const path = crashDataPath(crash.storagePath);
    return {
      filename: crash.filename || basename(path),
      contentType: crash.format === "CRASH" ? "text/plain" : "application/json",
      path,
    };
  }

  // dSYMs

  async dsyms(
    filter: DsymFilter = {},
    first?: number | null,
    after?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const where: Prisma.DsymWhereInput = { upload: { status: "READY" } };
    const and: Prisma.DsymWhereInput[] = [];
    const search = filter.search?.trim().toLowerCase();
    if (search) and.push({ searchText: { contains: search } });
    if (filter.buildId) {
      and.push({
        upload: {
          OR: [{ buildId: filter.buildId }, { linkedBuildId: filter.buildId }],
        },
      });
    }
    if (filter.projectName) {
      and.push({ upload: { projectName: filter.projectName } });
    }
    if (filter.uuid) {
      const uuid = filter.uuid.replaceAll("-", "").toUpperCase();
      and.push({ slices: { some: { uuid } } });
    }
    const combined: Prisma.DsymWhereInput = and.length
      ? { AND: [where, ...and] }
      : where;
    const cursor = decodeCursor(after);
    const size = pageSize(first);
    const [rows, totalCount, matchingCount] = await Promise.all([
      prisma.dsym.findMany({
        where: cursor ? { AND: [combined, olderThan(cursor)] } : combined,
        include: { upload: true, slices: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: size + 1,
      }),
      prisma.dsym.count({ where }),
      prisma.dsym.count({ where: combined }),
    ]);
    const nodes = rows.slice(0, size);
    return {
      nodes,
      nextCursor:
        rows.length > size ? encodeCursor(nodes[nodes.length - 1]!) : null,
      totalCount,
      matchingCount,
    };
  }

  async dsym(id: string) {
    const prisma = await getPrismaClient();
    return prisma.dsym.findUnique({
      where: { id },
      include: { upload: true, slices: true },
    });
  }

  async dsymProjects() {
    const prisma = await getPrismaClient();
    const rows = await prisma.dsymUpload.findMany({
      where: { projectName: { not: null }, status: "READY" },
      distinct: ["projectName"],
      select: { projectName: true },
      orderBy: { projectName: "asc" },
    });
    return rows
      .map((row) => row.projectName)
      .filter((value): value is string => Boolean(value));
  }

  async siblingDsyms(dsym: { id: string; uploadId: string }) {
    const prisma = await getPrismaClient();
    return prisma.dsym.findMany({
      where: { uploadId: dsym.uploadId, id: { not: dsym.id } },
      include: { upload: true, slices: true },
      orderBy: { bundleName: "asc" },
    });
  }

  async crashesForDsym(
    dsymId: string,
    first?: number | null,
    after?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const where: Prisma.CrashReportWhereInput = {
      binaryImages: { some: { dsymId } },
    };
    const cursor = decodeCursor(after);
    const size = pageSize(first);
    const [rows, count] = await Promise.all([
      prisma.crashReport.findMany({
        where: cursor ? { AND: [where, olderThan(cursor)] } : where,
        include: { binaryImages: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: size + 1,
      }),
      prisma.crashReport.count({ where }),
    ]);
    const nodes = rows.slice(0, size);
    return {
      nodes,
      nextCursor:
        rows.length > size ? encodeCursor(nodes[nodes.length - 1]!) : null,
      totalCount: count,
      matchingCount: count,
    };
  }

  async crashCountForDsym(dsymId: string) {
    const prisma = await getPrismaClient();
    return prisma.crashReport.count({
      where: { binaryImages: { some: { dsymId } } },
    });
  }

  async dsymCountForUpload(uploadId: string) {
    const prisma = await getPrismaClient();
    return prisma.dsym.count({ where: { uploadId } });
  }

  async dsymUploads(statuses?: string[] | null) {
    const prisma = await getPrismaClient();
    return prisma.dsymUpload.findMany({
      where: statuses?.length
        ? { status: { in: statuses } }
        : { status: { not: "READY" } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async updateDsymUpload(id: string, metadata: DsymMetadata) {
    const values = parseDsymMetadata(metadata);
    const prisma = await getPrismaClient();
    const upload = await prisma.dsymUpload.findUnique({ where: { id } });
    if (!upload) throw new CrashRequestError("dSYM upload not found", 404);
    const updated = await prisma.dsymUpload.update({
      where: { id },
      data: {
        buildId: values.buildId,
        url: values.url,
        projectName: values.projectName,
        linkedBuildId: await this.linkedBuild(values.buildId, upload),
      },
      include: { dsyms: { include: { slices: true } } },
    });
    await this.refreshDsymSearch(updated.dsyms, updated);
    this.publishDsyms(
      "UPDATED",
      updated.dsyms.map((dsym) => dsym.id),
    );
    return updated;
  }

  private async linkedBuild(
    buildId: string | null,
    upload?: { source: string; linkedBuildId: string | null },
  ): Promise<string | null> {
    if (upload?.source === "BUILD") return upload.linkedBuildId;
    if (!buildId) return null;
    const prisma = await getPrismaClient();
    const build = await prisma.build.findUnique({
      where: { id: buildId },
      select: { id: true },
    });
    return build?.id ?? null;
  }

  private async refreshDsymSearch(
    dsyms: {
      id: string;
      bundleName: string;
      binaryName: string;
      bundleIdentifier: string | null;
      shortVersion: string | null;
      bundleVersion: string | null;
      slices: { uuid: string }[];
    }[],
    upload: {
      buildId: string | null;
      projectName: string | null;
      linkedBuildId: string | null;
    },
  ) {
    const prisma = await getPrismaClient();
    for (const dsym of dsyms) {
      const searchText = [
        dsym.bundleName,
        dsym.binaryName,
        dsym.bundleIdentifier,
        dsym.shortVersion,
        dsym.bundleVersion,
        upload.buildId,
        upload.linkedBuildId,
        upload.projectName,
        ...dsym.slices.flatMap((slice) => [
          slice.uuid,
          `${slice.uuid.slice(0, 8)}-${slice.uuid.slice(8, 12)}-${slice.uuid.slice(12, 16)}-${slice.uuid.slice(16, 20)}-${slice.uuid.slice(20)}`,
        ]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .slice(0, 8_000);
      await prisma.dsym.update({
        where: { id: dsym.id },
        data: { searchText },
      });
    }
  }

  async deleteDsyms(ids: string[]) {
    if (!ids.length) return 0;
    const prisma = await getPrismaClient();
    const dsyms = await prisma.dsym.findMany({
      where: { id: { in: ids } },
      select: { id: true, uploadId: true, dwarfPath: true },
    });
    await prisma.dsym.deleteMany({
      where: { id: { in: dsyms.map((dsym) => dsym.id) } },
    });
    for (const dsym of dsyms) await removeCrashData(dsymFolder(dsym.dwarfPath));
    for (const uploadId of new Set(dsyms.map((dsym) => dsym.uploadId))) {
      const remaining = await prisma.dsym.count({ where: { uploadId } });
      if (remaining) continue;
      const upload = await prisma.dsymUpload.delete({
        where: { id: uploadId },
      });
      await removeCrashData(upload.storageDirectory);
      await removeCrashData(upload.stagingPath);
    }
    this.publishDsyms(
      "DELETED",
      dsyms.map((dsym) => dsym.id),
    );
    this.publishCrashes("UPDATED", []);
    return dsyms.length;
  }

  async deleteDsymUpload(id: string) {
    const prisma = await getPrismaClient();
    const upload = await prisma.dsymUpload.findUnique({
      where: { id },
      include: { dsyms: { select: { id: true } } },
    });
    if (!upload) return false;
    await prisma.dsymUpload.delete({ where: { id } });
    await removeCrashData(upload.storageDirectory);
    await removeCrashData(upload.stagingPath);
    this.publishDsyms(
      "DELETED",
      upload.dsyms.map((dsym) => dsym.id),
    );
    return true;
  }

  async retryDsymUpload(id: string) {
    const prisma = await getPrismaClient();
    const upload = await prisma.dsymUpload.findUnique({ where: { id } });
    if (!upload) throw new CrashRequestError("dSYM upload not found", 404);
    if (upload.status !== "FAILED" || !upload.buildArtifactId) {
      throw new CrashRequestError(
        "Only failed build imports can be retried; upload the zip again instead",
      );
    }
    const updated = await prisma.dsymUpload.update({
      where: { id },
      data: { status: "PENDING_TRANSFER", attempts: 0, error: null },
    });
    this.publishDsyms("UPDATED", []);
    this.changed();
    return updated;
  }

  /**
   * Indexes a zip that is already on disk into a dSYM upload. `zipPath` is
   * consumed: moved into, or deleted from, the crash data folder.
   */
  async importDsymZip(input: {
    zipPath: string;
    filename: string;
    sha256: string;
    sizeBytes: number;
    metadata: DsymMetadata;
    uploader: DsymUploader;
    uploadId?: string;
  }) {
    const metadata = parseDsymMetadata(input.metadata);
    const prisma = await getPrismaClient();
    const duplicate = await prisma.dsymUpload.findFirst({
      where: {
        sha256: input.sha256,
        status: "READY",
        id: input.uploadId ? { not: input.uploadId } : undefined,
      },
      orderBy: { createdAt: "desc" },
    });
    const current = input.uploadId
      ? await prisma.dsymUpload.findUnique({ where: { id: input.uploadId } })
      : null;
    if (duplicate) {
      await rm(input.zipPath, { force: true });
      if (input.uploadId) {
        await prisma.dsymUpload
          .delete({ where: { id: input.uploadId } })
          .catch(() => null);
      }
      if (current?.linkedBuildId && !duplicate.linkedBuildId) {
        await prisma.dsymUpload.update({
          where: { id: duplicate.id },
          data: { linkedBuildId: current.linkedBuildId },
        });
      }
      const changed =
        (metadata.buildId && metadata.buildId !== duplicate.buildId) ||
        (metadata.url && metadata.url !== duplicate.url) ||
        (metadata.projectName &&
          metadata.projectName !== duplicate.projectName);
      const upload = changed
        ? await this.updateDsymUpload(duplicate.id, {
            buildId: metadata.buildId ?? duplicate.buildId,
            url: metadata.url ?? duplicate.url,
            projectName: metadata.projectName ?? duplicate.projectName,
          })
        : duplicate;
      return {
        upload: await this.dsymUploadWithDsyms(upload.id),
        duplicate: true,
      };
    }

    const id = input.uploadId ?? randomUUID();
    const storageDirectory = `dsyms/${id}`;
    const linkedBuildId =
      current?.linkedBuildId ?? (await this.linkedBuild(metadata.buildId));
    const base = {
      filename: basename(input.filename).slice(0, 255) || "dSYMs.zip",
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      source: input.uploader.source,
      uploadedBy: input.uploader.uploadedBy,
      apiKeyId: input.uploader.apiKeyId,
      ownerKey: input.uploader.ownerKey,
      buildId: metadata.buildId,
      url: metadata.url,
      projectName: metadata.projectName,
      status: "PROCESSING",
      error: null,
      stagingPath: null,
      storageDirectory,
    };
    if (current) {
      await prisma.dsymUpload.update({
        where: { id },
        data: { ...base, linkedBuildId },
      });
    } else {
      await prisma.dsymUpload.create({
        data: { id, ...base, linkedBuildId },
      });
    }
    this.publishDsyms("UPDATED", []);
    try {
      const destination = await ensureCrashDataFolder(storageDirectory);
      const indexed = await extractDsymArchive({
        zipPath: input.zipPath,
        archiveName: base.filename,
        destination,
      });
      for (const dsym of indexed) {
        await prisma.dsym.create({
          data: {
            id: dsym.id,
            uploadId: id,
            bundleName: dsym.bundleName,
            binaryName: dsym.binaryName,
            bundleIdentifier: dsym.bundleIdentifier,
            shortVersion: dsym.shortVersion,
            bundleVersion: dsym.bundleVersion,
            dwarfPath: `${storageDirectory}/${dsym.dwarfPath}`,
            dwarfSha256: dsym.dwarfSha256,
            dwarfSizeBytes: dsym.dwarfSizeBytes,
            infoPlistPath: dsym.infoPlistPath
              ? `${storageDirectory}/${dsym.infoPlistPath}`
              : null,
            slices: {
              create: [
                ...new Map(
                  dsym.slices.map((slice) => [slice.uuid, slice]),
                ).values(),
              ].map((slice) => ({
                id: randomUUID(),
                uuid: slice.uuid,
                arch: slice.arch,
                textVmAddr: slice.textVmAddr,
              })),
            },
          },
        });
      }
      const upload = await prisma.dsymUpload.update({
        where: { id },
        data: { status: "READY", completedAt: new Date(), error: null },
        include: { dsyms: { include: { slices: true } } },
      });
      await this.refreshDsymSearch(upload.dsyms, upload);
      this.publishDsyms(
        "CREATED",
        upload.dsyms.map((dsym) => dsym.id),
      );
      await this.requeueCrashesFor(
        upload.dsyms.flatMap((dsym) => dsym.slices.map((slice) => slice.uuid)),
      );
      return { upload: await this.dsymUploadWithDsyms(id), duplicate: false };
    } catch (error) {
      await removeCrashData(storageDirectory);
      await prisma.dsym.deleteMany({ where: { uploadId: id } });
      await prisma.dsymUpload.update({
        where: { id },
        data: {
          status: "FAILED",
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            2_000,
          ),
          storageDirectory: null,
        },
      });
      this.publishDsyms("UPDATED", []);
      throw error;
    } finally {
      await rm(input.zipPath, { force: true });
    }
  }

  async dsymUploadWithDsyms(id: string) {
    const prisma = await getPrismaClient();
    return prisma.dsymUpload.findUniqueOrThrow({
      where: { id },
      include: {
        dsyms: { include: { slices: true }, orderBy: { bundleName: "asc" } },
      },
    });
  }

  /** Marks crashes waiting on these UUIDs for another pass. */
  private async requeueCrashesFor(uuids: string[]) {
    if (!uuids.length) return;
    const prisma = await getPrismaClient();
    const images = await prisma.crashBinaryImage.findMany({
      where: { uuid: { in: [...new Set(uuids)] }, frameCount: { gt: 0 } },
      select: { crashId: true },
      distinct: ["crashId"],
    });
    if (!images.length) return;
    await prisma.crashReport.updateMany({
      where: {
        id: { in: images.map((image) => image.crashId) },
        status: {
          in: ["MISSING_DSYMS", "PARTIALLY_SYMBOLICATED", "FAILED"],
        },
      },
      data: { status: "PENDING", attempts: 0, statusMessage: null },
    });
    this.changed();
  }

  // Resumable uploads

  async beginResumableUpload(input: {
    filename: string;
    sizeBytes: number;
    /** Optional: browsers cannot hash a multi-gigabyte file incrementally. */
    sha256: string | null;
    metadata: DsymMetadata;
    uploader: DsymUploader;
  }) {
    if (
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > DSYM_RESUMABLE_MAX_BYTES
    ) {
      throw new CrashRequestError(
        "sizeBytes must be between 1 byte and 20 GiB",
        413,
        "PAYLOAD_TOO_LARGE",
      );
    }
    if (input.sha256 !== null && !/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new CrashRequestError("sha256 must be a lowercase hex digest");
    }
    const metadata = parseDsymMetadata(input.metadata);
    const id = randomUUID();
    const stagingPath = `dsym-uploads/${id}.zip`;
    await ensureCrashDataFolder("dsym-uploads");
    const prisma = await getPrismaClient();
    const upload = await prisma.dsymUpload.create({
      data: {
        id,
        filename: basename(input.filename).slice(0, 255) || "dSYMs.zip",
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        stagingPath,
        source: input.uploader.source,
        uploadedBy: input.uploader.uploadedBy,
        apiKeyId: input.uploader.apiKeyId,
        ownerKey: input.uploader.ownerKey,
        buildId: metadata.buildId,
        url: metadata.url,
        projectName: metadata.projectName,
        linkedBuildId: await this.linkedBuild(metadata.buildId),
        status: "UPLOADING",
      },
    });
    this.publishDsyms("UPDATED", []);
    return { upload, chunkBytes: DSYM_UPLOAD_CHUNK_BYTES };
  }

  async resumableUpload(id: string, ownerKey: string | null) {
    const prisma = await getPrismaClient();
    const upload = await prisma.dsymUpload.findUnique({ where: { id } });
    if (!upload) throw new CrashRequestError("dSYM upload not found", 404);
    if (upload.ownerKey && upload.ownerKey !== ownerKey) {
      throw new CrashRequestError(
        "This upload belongs to another credential",
        403,
        "FORBIDDEN",
      );
    }
    return upload;
  }

  private readonly chunkLocks = new Map<string, Promise<unknown>>();

  private async withChunkLock<T>(id: string, work: () => Promise<T>) {
    const previous = this.chunkLocks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.chunkLocks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.chunkLocks.get(id) === next) this.chunkLocks.delete(id);
    }
  }

  async appendResumableChunk(input: {
    id: string;
    ownerKey: string | null;
    offset: number;
    bytes: Uint8Array;
  }) {
    return this.withChunkLock(input.id, async () => {
      const upload = await this.resumableUpload(input.id, input.ownerKey);
      if (upload.status !== "UPLOADING" || !upload.stagingPath) {
        throw new CrashRequestError(
          "The upload is no longer accepting data",
          409,
          "CONFLICT",
        );
      }
      if (input.offset !== upload.uploadOffset) {
        throw new CrashRequestError(
          `Upload offset mismatch; expected ${upload.uploadOffset}`,
          409,
          "OFFSET_MISMATCH",
        );
      }
      const length = input.bytes.byteLength;
      if (!length || length > DSYM_UPLOAD_CHUNK_BYTES) {
        throw new CrashRequestError(
          "Upload chunks must be 1 byte to 16 MiB",
          413,
          "PAYLOAD_TOO_LARGE",
        );
      }
      if (input.offset + length > upload.sizeBytes) {
        throw new CrashRequestError(
          "The chunk runs past the declared size",
          413,
          "PAYLOAD_TOO_LARGE",
        );
      }
      const { writeArtifactTransferBytes } =
        await import("@/services/builds/artifact-relay");
      const handle = await open(
        crashDataPath(upload.stagingPath),
        input.offset === 0 ? "w" : "r+",
        0o600,
      );
      try {
        await writeArtifactTransferBytes(handle, input.bytes, input.offset);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const prisma = await getPrismaClient();
      return prisma.dsymUpload.update({
        where: { id: upload.id },
        data: { uploadOffset: input.offset + length },
      });
    });
  }

  async completeResumableUpload(id: string, ownerKey: string | null) {
    return this.withChunkLock(id, async () => {
      const upload = await this.resumableUpload(id, ownerKey);
      if (upload.status === "READY") {
        return {
          upload: await this.dsymUploadWithDsyms(upload.id),
          duplicate: true,
        };
      }
      if (
        upload.status !== "UPLOADING" ||
        !upload.stagingPath ||
        upload.uploadOffset !== upload.sizeBytes
      ) {
        throw new CrashRequestError(
          `The upload is incomplete: ${upload.uploadOffset} of ${upload.sizeBytes} bytes received`,
          409,
          "INCOMPLETE_UPLOAD",
        );
      }
      const path = crashDataPath(upload.stagingPath);
      const actual = await fileSha256(path);
      if (upload.sha256 && actual !== upload.sha256) {
        const prisma = await getPrismaClient();
        await rm(path, { force: true });
        await prisma.dsymUpload.update({
          where: { id },
          data: {
            status: "FAILED",
            error: "The uploaded bytes do not match the declared sha256",
            stagingPath: null,
          },
        });
        this.publishDsyms("UPDATED", []);
        throw new CrashRequestError(
          "The uploaded bytes do not match the declared sha256",
          422,
          "CHECKSUM_MISMATCH",
        );
      }
      return this.importDsymZip({
        zipPath: path,
        filename: upload.filename,
        sha256: actual,
        sizeBytes: upload.sizeBytes,
        metadata: upload,
        uploader: {
          source: upload.source as DsymSource,
          uploadedBy: upload.uploadedBy,
          apiKeyId: upload.apiKeyId,
          ownerKey: upload.ownerKey,
        },
        uploadId: upload.id,
      });
    });
  }

  // Builds

  /** Records the dSYMs a finished build kept, for the runtime to pull in. */
  async queueBuildDsyms(jobId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const build = await prisma.build.findFirst({
      where: { jobId },
      include: {
        artifacts: { where: { kind: DSYMS_ARTIFACT_KIND } },
        repository: { select: { name: true } },
      },
    });
    if (!build?.artifacts.length) return;
    const app = build.repositoryId
      ? await prisma.appRepository.findFirst({
          where: { repositoryId: build.repositoryId },
          include: { app: { select: { name: true } } },
        })
      : null;
    for (const artifact of build.artifacts) {
      const exists = await prisma.dsymUpload.findUnique({
        where: { buildArtifactId: artifact.id },
      });
      if (exists) continue;
      await prisma.dsymUpload
        .create({
          data: {
            id: randomUUID(),
            filename: `${build.id}-dSYMs.zip`,
            sizeBytes: artifact.sizeBytes ?? 0,
            source: "BUILD",
            buildId: build.id,
            linkedBuildId: build.id,
            buildArtifactId: artifact.id,
            projectName: app?.app.name ?? build.repository?.name ?? null,
            status: "PENDING_TRANSFER",
          },
        })
        .catch(() => null);
    }
    this.publishDsyms("UPDATED", []);
    this.changed();
  }

  private async importBuildUpload(upload: {
    id: string;
    linkedBuildId: string | null;
    buildArtifactId: string | null;
    attempts: number;
    filename: string;
  }) {
    const prisma = await getPrismaClient();
    if (!upload.linkedBuildId || !upload.buildArtifactId) {
      await prisma.dsymUpload.update({
        where: { id: upload.id },
        data: {
          status: "FAILED",
          error: "The build or its dSYM artifact was deleted",
        },
      });
      return;
    }
    await prisma.dsymUpload.update({
      where: { id: upload.id },
      data: { attempts: { increment: 1 } },
    });
    const staging = `dsym-uploads/${upload.id}.zip`;
    try {
      const { materializeArtifact } =
        await import("@/services/builds/artifact-cache");
      const artifact = await materializeArtifact(
        upload.linkedBuildId,
        upload.buildArtifactId,
      );
      await ensureCrashDataFolder("dsym-uploads");
      const destination = crashDataPath(staging);
      await copyFile(artifact.path, destination);
      const size = (await stat(destination)).size;
      const sha256 = await fileSha256(destination);
      const current = await prisma.dsymUpload.findUniqueOrThrow({
        where: { id: upload.id },
      });
      await this.importDsymZip({
        zipPath: destination,
        filename: upload.filename,
        sha256,
        sizeBytes: size,
        metadata: current,
        uploader: {
          source: "BUILD",
          uploadedBy: null,
          apiKeyId: null,
          ownerKey: null,
        },
        uploadId: upload.id,
      });
    } catch (error) {
      await removeCrashData(staging);
      const message = error instanceof Error ? error.message : String(error);
      const permanent =
        error instanceof DsymIndexError ||
        upload.attempts + 1 >= MAX_BUILD_IMPORT_ATTEMPTS;
      await prisma.dsymUpload.update({
        where: { id: upload.id },
        data: permanent
          ? { status: "FAILED", error: message.slice(0, 2_000) }
          : {
              status: "PENDING_TRANSFER",
              error: `${message.slice(0, 1_900)}; retrying`,
            },
      });
      this.publishDsyms("UPDATED", []);
    }
  }

  // Agent access

  /**
   * The DWARF file an agent asked for, if one of its active symbolication jobs
   * lists that dSYM.
   */
  async agentDwarfFile(agentId: string, dsymId: string) {
    const prisma = await getPrismaClient();
    const jobs = await prisma.agentJob.findMany({
      where: {
        agentId,
        kind: CRASH_SYMBOLICATE_JOB_KIND,
        status: { in: ["QUEUED", "RUNNING"] },
      },
      select: { payloadJson: true },
    });
    const allowed = jobs.some((job) =>
      parseJson<CrashSymbolicationPayload | null>(
        job.payloadJson,
        null,
      )?.dsyms?.some((dsym) => dsym.dsymId === dsymId),
    );
    if (!allowed) return null;
    const dsym = await prisma.dsym.findUnique({ where: { id: dsymId } });
    if (!dsym) return null;
    return {
      path: crashDataPath(dsym.dwarfPath),
      size: dsym.dwarfSizeBytes,
      sha256: dsym.dwarfSha256,
      filename: dsym.binaryName,
    };
  }

  /** Files that make up a dSYM bundle, for zipping on download. */
  async dsymBundleFiles(dsymId: string) {
    const dsym = await this.dsym(dsymId);
    if (!dsym) return null;
    const folder = dsymFolder(dsym.dwarfPath);
    const entryName = (path: string) => path.slice(folder.length + 1);
    const files = [
      {
        name: entryName(dsym.dwarfPath),
        path: crashDataPath(dsym.dwarfPath),
      },
    ];
    if (dsym.infoPlistPath) {
      files.push({
        name: entryName(dsym.infoPlistPath),
        path: crashDataPath(dsym.infoPlistPath),
      });
    }
    return { dsym, files, filename: `${dsym.bundleName}.zip` };
  }

  // Runtime

  async reconcile(): Promise<void> {
    await this.recoverStuckJobs();
    await this.dispatchPending();
    await this.importPendingBuildUploads();
    await this.expireStaleUploads();
    await this.applyRetention();
    await this.pruneFinishedJobs();
  }

  private async recoverStuckJobs() {
    const prisma = await getPrismaClient();
    const running = await prisma.crashReport.findMany({
      where: { status: "SYMBOLICATING" },
      select: { id: true, jobId: true },
      take: 200,
    });
    for (const crash of running) {
      const job = crash.jobId
        ? await prisma.agentJob.findUnique({
            where: { id: crash.jobId },
            include: { agent: true },
          })
        : null;
      if (!job) {
        await prisma.crashReport.update({
          where: { id: crash.id },
          data: { status: "WAITING_FOR_AGENT", jobId: null },
        });
        continue;
      }
      if (
        ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)
      ) {
        // The completion was recorded but never projected, such as after a restart.
        await this.projectSymbolication(job);
        continue;
      }
      if (
        job.status === "QUEUED" &&
        !isOnline(job.agent) &&
        Date.now() - job.createdAt.getTime() > STALE_QUEUED_MS
      ) {
        await this.agentControl.cancelJob(job.id).catch(() => null);
      }
    }
  }

  private async dispatchPending() {
    const prisma = await getPrismaClient();
    const pending = await prisma.crashReport.findMany({
      where: { status: { in: ["PENDING", "WAITING_FOR_AGENT"] } },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: DISPATCH_PER_TICK,
    });
    for (const crash of pending) await this.prepare(crash.id);
    if (pending.length === DISPATCH_PER_TICK) this.rerun = true;
  }

  private async importPendingBuildUploads() {
    const prisma = await getPrismaClient();
    const uploads = await prisma.dsymUpload.findMany({
      where: { status: "PENDING_TRANSFER" },
      orderBy: { updatedAt: "asc" },
      take: BUILD_IMPORTS_PER_TICK,
    });
    for (const upload of uploads) await this.importBuildUpload(upload);
  }

  private async expireStaleUploads() {
    const prisma = await getPrismaClient();
    const stale = await prisma.dsymUpload.findMany({
      where: {
        status: "UPLOADING",
        updatedAt: { lt: new Date(Date.now() - STALE_UPLOAD_MS) },
      },
    });
    for (const upload of stale) {
      await removeCrashData(upload.stagingPath);
      await prisma.dsymUpload.delete({ where: { id: upload.id } });
    }
    if (stale.length) this.publishDsyms("DELETED", []);
  }

  private async applyRetention() {
    const settings = await this.settings();
    const prisma = await getPrismaClient();
    const cutoff = new Date(Date.now() - settings.retentionDays * 86_400_000);
    const expired = await prisma.crashReport.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: 500,
    });
    if (expired.length) {
      await this.deleteCrashReports(expired.map((crash) => crash.id));
    }
    if (settings.dsymRetentionDays) {
      const dsymCutoff = new Date(
        Date.now() - settings.dsymRetentionDays * 86_400_000,
      );
      const uploads = await prisma.dsymUpload.findMany({
        where: {
          createdAt: { lt: dsymCutoff },
          status: { in: ["READY", "FAILED"] },
        },
        select: { id: true },
        take: 100,
      });
      for (const upload of uploads) await this.deleteDsymUpload(upload.id);
    }
  }

  private async pruneFinishedJobs() {
    const prisma = await getPrismaClient();
    const active = await prisma.crashReport.findMany({
      where: { jobId: { not: null } },
      select: { jobId: true },
    });
    await prisma.agentJob.deleteMany({
      where: {
        kind: CRASH_SYMBOLICATE_JOB_KIND,
        status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] },
        finishedAt: { lt: new Date(Date.now() - FINISHED_JOB_RETENTION_MS) },
        id: { notIn: active.map((crash) => crash.jobId!) },
      },
    });
  }
}
