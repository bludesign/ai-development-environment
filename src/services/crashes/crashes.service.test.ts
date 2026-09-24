// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";

const materializeArtifact = vi.hoisted(() => vi.fn());
vi.mock("@/services/builds/artifact-cache", () => ({ materializeArtifact }));

const directory = mkdtempSync(join(tmpdir(), "crashes-service-"));
const fixtures = resolve(__dirname, "__fixtures__");
const APP_UUID = "776386D043863F249B215F7C02EB2873";

type Job = {
  id: string;
  agentId: string;
  payloadJson: string;
  status: string;
  resultJson: string | null;
  error: string | null;
};

let prisma: PrismaClient;
let service: import("./crashes.service").CrashesService;
const handlers = new Map<string, (job: Job) => Promise<void>>();
const observers: ((job: Job & { kind: string }) => Promise<void>)[] = [];

const agentControl = {
  registerCompletionHandler: (
    kind: string,
    handler: (job: Job) => Promise<void>,
  ) => handlers.set(kind, handler),
  registerCompletionObserver: (
    observer: (job: Job & { kind: string }) => Promise<void>,
  ) => observers.push(observer),
  registerConnectionHandler: () => undefined,
  cancelJob: vi.fn(),
  createJob: vi.fn(
    async (input: {
      agentId: string;
      kind: string;
      payload: unknown;
      idempotencyKey: string;
    }) =>
      prisma.agentJob.create({
        data: {
          id: randomUUID(),
          agentId: input.agentId,
          kind: input.kind,
          payloadJson: JSON.stringify(input.payload),
          status: "QUEUED",
          idempotencyKey: input.idempotencyKey,
          timeoutSeconds: 300,
          visibility: "SYSTEM",
        },
      }),
  ),
};

function copyFixture(name: string): string {
  const destination = join(directory, `${randomUUID()}-${name}`);
  copyFileSync(join(fixtures, name), destination);
  return destination;
}

async function importDsym(metadata = {}) {
  const zipPath = copyFixture("CrashDemo.dSYM.zip");
  const { fileSha256 } = await import("./crash-store");
  return service.importDsymZip({
    zipPath,
    filename: "CrashDemo.dSYM.zip",
    sha256: await fileSha256(zipPath),
    sizeBytes: readFileSync(zipPath).length,
    metadata,
    uploader: {
      source: "API",
      uploadedBy: "API key CI",
      apiKeyId: null,
      ownerKey: "api-key:key-1",
    },
  });
}

async function ingest(name: string) {
  return service.ingestCrashReport({
    bytes: readFileSync(join(fixtures, name)),
    filename: name,
    uploader: {
      source: "API",
      uploadedBy: null,
      apiKeyId: null,
      apiKeyName: null,
      clientIp: "203.0.113.7",
    },
  });
}

/** What `atos` answers for the CrashDemo fixture's three app offsets. */
async function completeLatestJob(crashId: string) {
  const crash = await prisma.crashReport.findUniqueOrThrow({
    where: { id: crashId },
  });
  const job = await prisma.agentJob.findUniqueOrThrow({
    where: { id: crash.jobId! },
  });
  const payload = JSON.parse(job.payloadJson);
  const names: Record<string, [string, number]> = {
    "0xd6c": ["Loader.item(at:)", 3],
    "0xb18": ["handleTap(_:)", 5],
    "0x9c8": ["main", 6],
  };
  const completed = await prisma.agentJob.update({
    where: { id: job.id },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      resultJson: JSON.stringify({
        exitCode: 0,
        lookups: payload.lookups.map(
          (lookup: { dsymId: string; uuid: string; offsets: string[] }) => ({
            dsymId: lookup.dsymId,
            uuid: lookup.uuid,
            error: null,
            results: lookup.offsets.map((offset) => ({
              offset,
              frames: names[offset]
                ? [
                    {
                      symbol: names[offset]![0],
                      image: "CrashDemo",
                      file: "/src/boom.swift",
                      line: names[offset]![1],
                      symbolOffset: null,
                    },
                  ]
                : [],
            })),
          }),
        ),
        xcodeVersion: "Xcode 27.0",
      }),
    },
  });
  await handlers.get("ios.crash.symbolicate")!(completed);
}

beforeAll(async () => {
  const databasePath = join(directory, "crashes.db");
  const database = new Database(databasePath);
  const migrations = resolve(process.cwd(), "prisma/migrations");
  database.transaction(() => {
    for (const name of readdirSync(migrations).sort()) {
      if (!name.match(/^\d{14}_/)) continue;
      database.exec(
        readFileSync(join(migrations, name, "migration.sql"), "utf8"),
      );
    }
  })();
  database.close();
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.CRASH_DATA_DIRECTORY = join(directory, "crash-data");
  process.env.CRASH_RUNTIME_DISABLED = "1";
  delete (globalThis as typeof globalThis & { prismaGlobal?: unknown })
    .prismaGlobal;
  const { getPrismaClient } = await import("@/data/prisma-client");
  prisma = await getPrismaClient();
  const { CrashesService } = await import("./crashes.service");
  service = new CrashesService(agentControl as never);
  await prisma.agent.create({
    data: {
      id: "agent-mac",
      name: "Studio",
      hostname: "studio.local",
      version: "1",
      osVersion: "macOS 25.6.0",
      architecture: "arm64",
      capabilitiesJson: JSON.stringify(["ios.crash.symbolicate"]),
      secretHash: "hash",
      lastSeenAt: new Date(),
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  delete process.env.DATABASE_URL;
  delete process.env.CRASH_DATA_DIRECTORY;
  delete process.env.CRASH_RUNTIME_DISABLED;
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.crashReport.deleteMany();
  await prisma.dsymUpload.deleteMany();
  await prisma.agentJob.deleteMany();
});

describe("CrashesService", () => {
  test("waits for a dSYM, then symbolicates on the macOS agent", async () => {
    const { crashes } = await ingest("CrashDemo.ips");
    const [crash] = crashes;
    expect(crash).toMatchObject({
      status: "MISSING_DSYMS",
      statusMessage: "Missing dSYMs for CrashDemo",
      signatureTitle: "EXC_BREAKPOINT · CrashDemo+0xd6c",
    });
    expect(crash!.binaryImages).toEqual([
      expect.objectContaining({ uuid: APP_UUID, frameCount: 3, dsymId: null }),
    ]);

    const { upload } = await importDsym({ projectName: "Demo", buildId: "7" });
    expect(upload).toMatchObject({ status: "READY", projectName: "Demo" });
    const dsymId = upload.dsyms[0]!.id;
    await service.reconcile();

    const dispatched = await prisma.crashReport.findUniqueOrThrow({
      where: { id: crash!.id },
    });
    expect(dispatched).toMatchObject({
      status: "SYMBOLICATING",
      agentId: "agent-mac",
      attempts: 1,
    });
    const job = await prisma.agentJob.findUniqueOrThrow({
      where: { id: dispatched.jobId! },
    });
    expect(JSON.parse(job.payloadJson)).toMatchObject({
      crashId: crash!.id,
      dsyms: [
        {
          dsymId,
          binaryName: "CrashDemo",
          downloadPath: `/api/agent/dsyms/${dsymId}/dwarf`,
        },
      ],
      lookups: [
        {
          dsymId,
          uuid: APP_UUID,
          arch: "arm64",
          offsets: ["0xd6c", "0xb18", "0x9c8"],
        },
      ],
    });
    // Only the agent running that job may fetch the DWARF file.
    expect(await service.agentDwarfFile("agent-mac", dsymId)).toMatchObject({
      filename: "CrashDemo",
    });
    expect(await service.agentDwarfFile("agent-other", dsymId)).toBeNull();

    await completeLatestJob(crash!.id);
    const symbolicated = await service.crashReport(crash!.id);
    expect(symbolicated).toMatchObject({
      status: "SYMBOLICATED",
      signatureTitle: "EXC_BREAKPOINT · Loader.item(at:)",
      jobId: null,
    });
    expect(symbolicated!.binaryImages[0]!.dsymId).toBe(dsymId);
    expect(await service.crashCountForDsym(dsymId)).toBe(1);
    expect(await service.agentDwarfFile("agent-mac", dsymId)).toBeNull();

    // A retried completion of the same job changes nothing.
    await handlers.get("ios.crash.symbolicate")!(
      await prisma.agentJob.findUniqueOrThrow({ where: { id: job.id } }),
    );
    expect((await service.crashReport(crash!.id))!.status).toBe("SYMBOLICATED");
  });

  test("symbolicates text and MetricKit reports against the same dSYM", async () => {
    await importDsym();
    const text = (await ingest("CrashDemo.crash")).crashes[0]!;
    const metrickit = (await ingest("metrickit-payload.json")).crashes[0]!;
    for (const crash of [text, metrickit]) {
      expect(crash.status).toBe("SYMBOLICATING");
      await completeLatestJob(crash.id);
      expect((await service.crashReport(crash.id))!.status).toBe(
        "SYMBOLICATED",
      );
    }
    // Same exception and frames give the same signature across formats.
    const [first, second] = await Promise.all([
      service.crashReport(text.id),
      service.crashReport(metrickit.id),
    ]);
    expect(first!.signature).toBe(second!.signature);
    expect(await service.similarCrashCount(first!)).toBe(1);
  });

  test("treats a re-sent report and a re-uploaded zip as duplicates", async () => {
    const first = await ingest("CrashDemo.ips");
    const again = await ingest("CrashDemo.ips");
    expect(again.duplicate).toBe(true);
    expect(again.crashes[0]!.id).toBe(first.crashes[0]!.id);

    const original = await importDsym();
    const repeat = await importDsym({ buildId: "99" });
    expect(repeat.duplicate).toBe(true);
    expect(repeat.upload.id).toBe(original.upload.id);
    expect(repeat.upload.buildId).toBe("99");
    expect(await prisma.dsymUpload.count()).toBe(1);
  });

  test("waits for an agent, and keeps symbols when the dSYM is deleted", async () => {
    await prisma.agent.update({
      where: { id: "agent-mac" },
      data: { disconnectedAt: new Date() },
    });
    const { upload } = await importDsym();
    const crash = (await ingest("CrashDemo.ips")).crashes[0]!;
    expect(crash.status).toBe("WAITING_FOR_AGENT");
    await prisma.agent.update({
      where: { id: "agent-mac" },
      data: { disconnectedAt: null, lastSeenAt: new Date() },
    });
    await service.reconcile();
    await completeLatestJob(crash.id);

    await service.deleteDsyms([upload.dsyms[0]!.id]);
    const after = await service.crashReport(crash.id);
    expect(after!.status).toBe("SYMBOLICATED");
    expect(after!.binaryImages[0]!.dsymId).toBeNull();
    expect(after!.symbolicationJson).toContain("Loader.item(at:)");
    expect(await prisma.dsymUpload.count()).toBe(0);
  });

  test("retries failed symbolication and gives up after three attempts", async () => {
    await importDsym();
    const crash = (await ingest("CrashDemo.ips")).crashes[0]!;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const current = await prisma.crashReport.findUniqueOrThrow({
        where: { id: crash.id },
      });
      expect(current.attempts).toBe(attempt);
      const failed = await prisma.agentJob.update({
        where: { id: current.jobId! },
        data: {
          status: "FAILED",
          error: "atos crashed",
          finishedAt: new Date(),
        },
      });
      await handlers.get("ios.crash.symbolicate")!(failed);
      await service.reconcile();
    }
    expect(await service.crashReport(crash.id)).toMatchObject({
      status: "FAILED",
      statusMessage: "atos crashed",
    });

    // Asking again starts a fresh generation with a new job.
    await service.symbolicate(crash.id);
    expect(await service.crashReport(crash.id)).toMatchObject({
      status: "SYMBOLICATING",
      attempts: 1,
      generation: 1,
    });
  });

  test("imports the dSYMs a build kept", async () => {
    await prisma.build.create({
      data: {
        id: "build-1",
        requestKey: "request-1",
        requestId: "request-1",
        action: "ARCHIVE",
        destinationType: "PHYSICAL_DEVICE",
        destinationJson: "{}",
        snapshotJson: "{}",
        commandSummary: "xcodebuild archive",
        artifactDirectory: "/tmp/Builds/build-1",
        jobId: null,
        status: "SUCCEEDED",
        artifacts: {
          create: {
            id: "artifact-1",
            kind: "DSYMS",
            relativePath: "dSYMs.zip",
            sizeBytes: 5918,
          },
        },
      },
    });
    const job = await prisma.agentJob.create({
      data: {
        id: "build-job",
        agentId: "agent-mac",
        kind: "ios.build.run",
        payloadJson: "{}",
        status: "SUCCEEDED",
        idempotencyKey: "build-job",
        timeoutSeconds: 60,
      },
    });
    await prisma.build.update({
      where: { id: "build-1" },
      data: { jobId: job.id },
    });
    materializeArtifact.mockResolvedValue({
      path: copyFixture("CrashDemo.dSYM.zip"),
      filename: "dSYMs.zip",
      contentType: "application/zip",
      size: 5918,
      etag: "etag",
    });
    for (const observer of observers) {
      await observer({ ...job, kind: "ios.build.run" });
    }
    const pending = await prisma.dsymUpload.findFirstOrThrow();
    expect(pending).toMatchObject({
      status: "PENDING_TRANSFER",
      source: "BUILD",
      linkedBuildId: "build-1",
      buildArtifactId: "artifact-1",
    });
    await service.reconcile();
    expect(materializeArtifact).toHaveBeenCalledWith("build-1", "artifact-1");
    const dsyms = await service.dsyms({ buildId: "build-1" });
    expect(dsyms.nodes.map((dsym) => dsym.bundleName)).toEqual([
      "CrashDemo.dSYM",
    ]);
    expect(dsyms.nodes[0]!.upload).toMatchObject({
      status: "READY",
      source: "BUILD",
    });
  });

  test("resumes chunked uploads and checks the declared digest", async () => {
    const bytes = readFileSync(join(fixtures, "CrashDemo.dSYM.zip"));
    const { createHash } = await import("node:crypto");
    const { upload } = await service.beginResumableUpload({
      filename: "dSYMs.zip",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metadata: { projectName: "Demo" },
      uploader: {
        source: "API",
        uploadedBy: "API key CI",
        apiKeyId: "key-1",
        ownerKey: "api-key:key-1",
      },
    });
    await service.appendResumableChunk({
      id: upload.id,
      ownerKey: "api-key:key-1",
      offset: 0,
      bytes: bytes.subarray(0, 1000),
    });
    await expect(
      service.appendResumableChunk({
        id: upload.id,
        ownerKey: "api-key:key-1",
        offset: 0,
        bytes: bytes.subarray(0, 1000),
      }),
    ).rejects.toThrow("expected 1000");
    await expect(
      service.resumableUpload(upload.id, "api-key:someone-else"),
    ).rejects.toThrow("another credential");
    await expect(
      service.completeResumableUpload(upload.id, "api-key:key-1"),
    ).rejects.toThrow("incomplete");
    await service.appendResumableChunk({
      id: upload.id,
      ownerKey: "api-key:key-1",
      offset: 1000,
      bytes: bytes.subarray(1000),
    });
    const completed = await service.completeResumableUpload(
      upload.id,
      "api-key:key-1",
    );
    expect(completed.upload).toMatchObject({
      id: upload.id,
      status: "READY",
      projectName: "Demo",
    });
    expect(completed.upload.dsyms[0]!.slices[0]!.uuid).toBe(APP_UUID);
  });
});
