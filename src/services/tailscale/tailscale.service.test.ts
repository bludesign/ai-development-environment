// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import {
  TAILSCALE_SERVE_INSPECT_JOB_KIND,
  TAILSCALE_SERVE_REMOVE_JOB_KIND,
  TAILSCALE_SERVE_UPSERT_JOB_KIND,
  tailscaleServeFingerprint,
  type TailscaleServeRoute,
  type TailscaleServeSnapshot,
} from "@ai-development-environment/agent-contract/tailscale";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { PrismaClient } from "@/generated/prisma/client";
import type { AgentControlService } from "@/services/agent-control";

import {
  parseTailscaleServeJobResult,
  tailscaleRoutesConflict,
  TailscaleServeService,
  type TailscaleTemplateInput,
} from "./tailscale.service";

const webRoute: TailscaleServeRoute = {
  protocol: "HTTPS",
  listenPort: 443,
  mountPath: "/api",
  destination: { protocol: "HTTP", port: 3000, path: "" },
  funnel: false,
  appCapabilities: [],
  proxyProtocol: "NONE",
};

const supportedCapabilities = JSON.stringify([
  TAILSCALE_SERVE_INSPECT_JOB_KIND,
  TAILSCALE_SERVE_UPSERT_JOB_KIND,
  TAILSCALE_SERVE_REMOVE_JOB_KIND,
]);

type QueuedJob = {
  id: string;
  agentId: string;
  kind: string;
  payload: unknown;
};

function snapshot(
  routes: TailscaleServeRoute[],
  inspectedAt = "2026-08-29T12:00:00.000Z",
): TailscaleServeSnapshot {
  return {
    identity: {
      dnsHostname: "agent.example.ts.net",
      ipv4: ["100.64.0.1"],
      ipv6: ["fd7a:115c:a1e0::1"],
      backendState: "Running",
    },
    routes,
    inspectedAt,
  };
}

function templateInput(
  assignments: TailscaleTemplateInput["assignments"],
  overrides: Partial<TailscaleTemplateInput> = {},
): TailscaleTemplateInput {
  return {
    name: "Developer API",
    protocol: "HTTPS",
    listenPort: 443,
    mountPath: "/api",
    destinationProtocol: "HTTP",
    destinationPort: 3000,
    destinationPath: "",
    funnel: false,
    appCapabilities: [],
    proxyProtocol: "NONE",
    assignments,
    ...overrides,
  };
}

describe("TailscaleServeService contracts", () => {
  it("allows compatible web mount paths and rejects listener conflicts", () => {
    expect(
      tailscaleRoutesConflict(webRoute, {
        ...webRoute,
        mountPath: "/admin",
      }),
    ).toBe(false);
    expect(tailscaleRoutesConflict(webRoute, webRoute)).toBe(true);
    expect(
      tailscaleRoutesConflict(webRoute, {
        ...webRoute,
        protocol: "HTTP",
      }),
    ).toBe(true);
    expect(
      tailscaleRoutesConflict(
        {
          protocol: "TCP",
          listenPort: 5432,
          mountPath: "/",
          destination: { protocol: "TCP", port: 5432, path: "" },
          funnel: false,
          appCapabilities: [],
          proxyProtocol: "NONE",
        },
        {
          protocol: "TCP",
          listenPort: 5432,
          mountPath: "/",
          destination: { protocol: "TCP", port: 6432, path: "" },
          funnel: false,
          appCapabilities: [],
          proxyProtocol: "NONE",
        },
      ),
    ).toBe(true);
  });

  it("rejects malformed or incomplete job result JSON", () => {
    expect(() => parseTailscaleServeJobResult("not-json")).toThrow();
    expect(() => parseTailscaleServeJobResult("{}")).toThrow(
      /invalid snapshot/,
    );
    expect(() =>
      parseTailscaleServeJobResult(
        JSON.stringify({ snapshot: { identity: {}, routes: "invalid" } }),
      ),
    ).toThrow(/invalid snapshot/);
  });
});

describe("TailscaleServeService persistence", () => {
  let directory: string;
  let templateDatabasePath: string;
  let databaseCount = 0;
  let prisma: InstanceType<typeof PrismaClient>;
  let service: TailscaleServeService;
  let jobs: QueuedJob[];
  let completions: Map<string, (job: never) => Promise<void>>;
  let createJob: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "aide-tailscale-"));
    templateDatabasePath = join(directory, "template.db");
    const database = new Database(templateDatabasePath);
    database.pragma("foreign_keys = ON");
    const migrationsRoot = resolve(process.cwd(), "prisma/migrations");
    database.transaction(() => {
      for (const migration of readdirSync(migrationsRoot).toSorted()) {
        const path = join(migrationsRoot, migration, "migration.sql");
        if (existsSync(path)) database.exec(readFileSync(path, "utf8"));
      }
    })();
    database.close();
  }, 120_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const databasePath = join(directory, `test-${(databaseCount += 1)}.db`);
    await copyFile(templateDatabasePath, databasePath);
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: databasePath }),
    });
    mocks.getPrismaClient.mockResolvedValue(prisma);
    await prisma.agent.createMany({
      data: ["agent-1", "agent-2"].map((id) => ({
        id,
        name: id === "agent-1" ? "Build Mac" : "Studio Mac",
        hostname: `${id}.local`,
        version: "1.0.0",
        osVersion: "macOS",
        architecture: "arm64",
        capabilitiesJson: supportedCapabilities,
        secretHash: `${id}-secret`,
      })),
    });
    jobs = [];
    completions = new Map();
    createJob = vi.fn(
      async (input: Parameters<AgentControlService["createJob"]>[0]) => {
        const job = {
          id: `job-${jobs.length + 1}`,
          agentId: input.agentId,
          kind: input.kind,
          payload: input.payload,
        };
        jobs.push(job);
        return prisma.agentJob.create({
          data: {
            id: job.id,
            agentId: job.agentId,
            kind: job.kind,
            payloadJson: JSON.stringify(job.payload),
            status: "QUEUED",
            idempotencyKey: input.idempotencyKey,
            timeoutSeconds: input.timeoutSeconds ?? 90,
          },
        });
      },
    );
    service = new TailscaleServeService({
      registerCompletionHandler: vi.fn((kind, handler) => {
        completions.set(kind, handler as (job: never) => Promise<void>);
      }),
      createJob,
    } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
  });

  async function complete(
    job: QueuedJob,
    status: "SUCCEEDED" | "FAILED",
    observed = snapshot([]),
    error: string | null = null,
  ) {
    await completions.get(job.kind)!({
      id: job.id,
      agentId: job.agentId,
      kind: job.kind,
      payloadJson: JSON.stringify(job.payload),
      status,
      resultJson:
        status === "SUCCEEDED"
          ? JSON.stringify({
              exitCode: 0,
              signal: null,
              timedOut: false,
              cancelled: false,
              snapshot: observed,
            })
          : null,
      error,
    } as never);
  }

  async function seedTemplate(agentIds = ["agent-1"]) {
    await prisma.tailscaleServeTemplate.create({
      data: {
        id: "template-1",
        name: "Developer API",
        protocol: webRoute.protocol,
        listenPort: webRoute.listenPort,
        mountPath: webRoute.mountPath,
        destinationProtocol: webRoute.destination.protocol,
        destinationPort: webRoute.destination.port,
        destinationPath: webRoute.destination.path,
        funnel: webRoute.funnel,
        appCapabilitiesJson: JSON.stringify(webRoute.appCapabilities),
        proxyProtocol: webRoute.proxyProtocol,
        fingerprint: tailscaleServeFingerprint(webRoute),
        assignments: {
          create: agentIds.map((agentId) => ({
            agentId,
            desiredEnabled: true,
            observedEnabled: true,
            observedFingerprint: tailscaleServeFingerprint(webRoute),
            status: "SUCCEEDED",
          })),
        },
      },
    });
  }

  it("returns the original operation when an upsert request is retried", async () => {
    const input = templateInput([{ agentId: "agent-1", enabled: true }]);
    const created = await service.upsert(input, "idempotent-create");
    const createRetry = await service.upsert(input, "idempotent-create");

    expect(createRetry.id).toBe(created.id);
    expect(await prisma.tailscaleServeTemplate.count()).toBe(1);
    expect(jobs).toHaveLength(1);

    const update = templateInput([{ agentId: "agent-1", enabled: true }], {
      id: created.templateId,
      expectedRevision: 1,
      destinationPort: 4000,
    });
    const updated = await service.upsert(update, "idempotent-update");
    const updateRetry = await service.upsert(update, "idempotent-update");

    expect(updateRetry.id).toBe(updated.id);
    expect(jobs).toHaveLength(2);
    expect(
      await prisma.tailscaleServeTemplate.findUniqueOrThrow({
        where: { id: created.templateId! },
      }),
    ).toMatchObject({ revision: 2, destinationPort: 4000 });
  });

  it("allows only one concurrent update for an expected revision", async () => {
    await seedTemplate();
    const results = await Promise.allSettled([
      service.upsert(
        templateInput([{ agentId: "agent-1", enabled: true }], {
          id: "template-1",
          expectedRevision: 1,
          destinationPort: 4000,
        }),
        "concurrent-update-1",
      ),
      service.upsert(
        templateInput([{ agentId: "agent-1", enabled: true }], {
          id: "template-1",
          expectedRevision: 1,
          destinationPort: 5000,
        }),
        "concurrent-update-2",
      ),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await prisma.tailscaleServeTemplate.findUniqueOrThrow({
        where: { id: "template-1" },
      }),
    ).toMatchObject({ revision: 2 });
    expect(jobs).toHaveLength(1);
  });

  it("persists terminal assignment state when dispatch cannot start", async () => {
    await prisma.agent.update({
      where: { id: "agent-1" },
      data: { capabilitiesJson: "[]" },
    });
    createJob.mockRejectedValueOnce(new Error("queue unavailable"));

    const operation = await service.upsert(
      templateInput([
        { agentId: "agent-1", enabled: true },
        { agentId: "agent-2", enabled: true },
      ]),
      "dispatch-failures",
    );

    expect(operation.status).toBe("FAILED");
    expect(
      await prisma.tailscaleServeAssignment.findMany({
        where: { templateId: operation.templateId! },
        orderBy: { agentId: "asc" },
        select: { agentId: true, status: true, lastError: true },
      }),
    ).toEqual([
      {
        agentId: "agent-1",
        status: "UNSUPPORTED",
        lastError: "This agent does not advertise Tailscale Serve support",
      },
      {
        agentId: "agent-2",
        status: "FAILED",
        lastError: "queue unavailable",
      },
    ]);
  });

  it("groups exact imported routes and attaches listener drift without duplicates", async () => {
    await service.inspect(["agent-1", "agent-2"], "inspect-group");
    await complete(jobs[0]!, "SUCCEEDED", snapshot([webRoute]));
    await complete(jobs[1]!, "SUCCEEDED", snapshot([webRoute]));

    let templates = await prisma.tailscaleServeTemplate.findMany({
      include: { assignments: true },
    });
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ origin: "IMPORTED" });
    expect(templates[0]!.assignments).toHaveLength(2);

    const driftedRoute = {
      ...webRoute,
      destination: { ...webRoute.destination, port: 4000 },
    };
    await service.inspect(["agent-1"], "inspect-drift");
    await complete(jobs[2]!, "SUCCEEDED", snapshot([driftedRoute]));

    templates = await prisma.tailscaleServeTemplate.findMany({
      include: { assignments: true },
    });
    expect(templates).toHaveLength(1);
    expect(templates[0]!.assignments[0]!.observedFingerprint).toBe(
      tailscaleServeFingerprint(driftedRoute),
    );
    expect(templates[0]!.fingerprint).toBe(tailscaleServeFingerprint(webRoute));
  });

  it("does not project an inspection older than the persisted snapshot", async () => {
    await seedTemplate();
    const replacement = {
      ...webRoute,
      destination: { ...webRoute.destination, port: 4000 },
    };
    await service.inspect(["agent-1"], "newer-inspection");
    await service.inspect(["agent-1"], "older-inspection");

    await complete(
      jobs[0]!,
      "SUCCEEDED",
      snapshot([replacement], "2026-08-29T13:00:00.000Z"),
    );
    await complete(
      jobs[1]!,
      "SUCCEEDED",
      snapshot([webRoute], "2026-08-29T12:00:00.000Z"),
    );

    const state = await prisma.tailscaleAgentState.findUniqueOrThrow({
      where: { agentId: "agent-1" },
    });
    expect(state.lastInspectedAt?.toISOString()).toBe(
      "2026-08-29T13:00:00.000Z",
    );
    expect(JSON.parse(state.routesJson)).toEqual([replacement]);
    expect(
      await prisma.tailscaleServeAssignment.findUniqueOrThrow({
        where: {
          templateId_agentId: {
            templateId: "template-1",
            agentId: "agent-1",
          },
        },
      }),
    ).toMatchObject({
      observedFingerprint: tailscaleServeFingerprint(replacement),
    });
  });

  it("ignores stale revisions while replacements move to the latest route", async () => {
    const first = await service.upsert(
      templateInput([{ agentId: "agent-1", enabled: true }]),
      "create-template",
    );
    const second = await service.upsert(
      templateInput([{ agentId: "agent-1", enabled: true }], {
        id: first.templateId,
        expectedRevision: 1,
        destinationPort: 4000,
      }),
      "update-template",
    );
    expect(second.templateId).toBe(first.templateId);
    expect(jobs[1]!.payload).toMatchObject({
      revision: 2,
      previousRoute: webRoute,
    });

    await complete(jobs[0]!, "SUCCEEDED", snapshot([webRoute]));
    let assignment = await prisma.tailscaleServeAssignment.findUniqueOrThrow({
      where: {
        templateId_agentId: {
          templateId: first.templateId!,
          agentId: "agent-1",
        },
      },
    });
    expect(assignment).toMatchObject({
      revision: 2,
      status: "QUEUED",
      lastJobId: jobs[1]!.id,
      observedFingerprint: tailscaleServeFingerprint(webRoute),
    });

    const replacement = {
      ...webRoute,
      destination: { ...webRoute.destination, port: 4000 },
    };
    await complete(jobs[1]!, "SUCCEEDED", snapshot([replacement]));
    assignment = await prisma.tailscaleServeAssignment.findUniqueOrThrow({
      where: {
        templateId_agentId: {
          templateId: first.templateId!,
          agentId: "agent-1",
        },
      },
    });
    expect(assignment).toMatchObject({
      revision: 2,
      status: "SUCCEEDED",
      lastJobId: jobs[1]!.id,
      observedFingerprint: tailscaleServeFingerprint(replacement),
    });
  });

  it("retains assignments while toggling them off and back on", async () => {
    await seedTemplate();
    await service.setAgentEnabled(
      "template-1",
      "agent-1",
      false,
      1,
      "disable-agent",
    );
    expect(jobs[0]!.kind).toBe(TAILSCALE_SERVE_REMOVE_JOB_KIND);
    await complete(jobs[0]!, "SUCCEEDED");
    expect(
      await prisma.tailscaleServeAssignment.findUniqueOrThrow({
        where: {
          templateId_agentId: {
            templateId: "template-1",
            agentId: "agent-1",
          },
        },
      }),
    ).toMatchObject({ desiredEnabled: false, observedEnabled: false });

    await service.setAgentEnabled(
      "template-1",
      "agent-1",
      true,
      1,
      "enable-agent",
    );
    expect(jobs[1]!.kind).toBe(TAILSCALE_SERVE_UPSERT_JOB_KIND);
    await complete(jobs[1]!, "SUCCEEDED", snapshot([webRoute]));
    expect(
      await prisma.tailscaleServeAssignment.findUniqueOrThrow({
        where: {
          templateId_agentId: {
            templateId: "template-1",
            agentId: "agent-1",
          },
        },
      }),
    ).toMatchObject({ desiredEnabled: true, observedEnabled: true });
  });

  it("removes newly disabled agents while updating every retained enabled agent", async () => {
    await seedTemplate(["agent-1", "agent-2"]);
    await service.upsert(
      templateInput([{ agentId: "agent-1", enabled: false }], {
        id: "template-1",
        expectedRevision: 1,
        destinationPort: 4000,
      }),
      "mixed-template-edit",
    );

    const disableJob = jobs.find(({ agentId }) => agentId === "agent-1")!;
    const updateJob = jobs.find(({ agentId }) => agentId === "agent-2")!;
    expect(disableJob).toMatchObject({
      kind: TAILSCALE_SERVE_REMOVE_JOB_KIND,
      payload: { revision: 2, route: webRoute },
    });
    expect(updateJob).toMatchObject({
      kind: TAILSCALE_SERVE_UPSERT_JOB_KIND,
      payload: { revision: 2, previousRoute: webRoute },
    });

    const replacement = {
      ...webRoute,
      destination: { ...webRoute.destination, port: 4000 },
    };
    await complete(disableJob, "SUCCEEDED");
    await complete(updateJob, "SUCCEEDED", snapshot([replacement]));
    const assignments = await prisma.tailscaleServeAssignment.findMany({
      where: { templateId: "template-1" },
      orderBy: { agentId: "asc" },
    });
    expect(assignments).toMatchObject([
      { agentId: "agent-1", desiredEnabled: false, observedEnabled: false },
      { agentId: "agent-2", desiredEnabled: true, observedEnabled: true },
    ]);
  });

  it("reports partial fleet failure while retaining failed desired state", async () => {
    const operation = await service.upsert(
      templateInput([
        { agentId: "agent-1", enabled: true },
        { agentId: "agent-2", enabled: true },
      ]),
      "partial-upsert",
    );
    await complete(jobs[0]!, "SUCCEEDED", snapshot([webRoute]));
    await complete(jobs[1]!, "FAILED", snapshot([]), "daemon unavailable");

    const finalized = await service.operation(operation.id);
    expect(finalized?.agents[0]?.error).toBeNull();
    expect(
      finalized?.agents.map(({ agentId, status }) => ({ agentId, status })),
    ).toEqual([
      { agentId: "agent-1", status: "SUCCEEDED" },
      { agentId: "agent-2", status: "FAILED" },
    ]);
    expect(finalized).toMatchObject({
      status: "PARTIAL_FAILED",
    });
    expect(
      await prisma.tailscaleServeAssignment.findUniqueOrThrow({
        where: {
          templateId_agentId: {
            templateId: operation.templateId!,
            agentId: "agent-2",
          },
        },
      }),
    ).toMatchObject({
      desiredEnabled: true,
      status: "FAILED",
      lastError: "daemon unavailable",
    });
  });

  it("retains failed deletions and purges the template after a retry", async () => {
    await seedTemplate(["agent-1", "agent-2"]);
    const first = await service.delete("template-1", 1, "delete-first");
    const firstAgent = jobs.find((job) => job.agentId === "agent-1")!;
    const secondAgent = jobs.find((job) => job.agentId === "agent-2")!;
    await complete(firstAgent, "SUCCEEDED");
    await complete(secondAgent, "FAILED", snapshot([]), "agent offline");

    const finalized = await service.operation(first.id);
    expect(finalized?.agents[0]?.error).toBeNull();
    expect(
      finalized?.agents.map(({ agentId, status }) => ({ agentId, status })),
    ).toEqual([
      { agentId: "agent-1", status: "SUCCEEDED" },
      { agentId: "agent-2", status: "FAILED" },
    ]);
    expect(finalized).toMatchObject({
      status: "PARTIAL_FAILED",
    });
    expect(
      await prisma.tailscaleServeTemplate.findUniqueOrThrow({
        where: { id: "template-1" },
      }),
    ).toMatchObject({ lifecycle: "DELETING" });

    await service.delete("template-1", 1, "delete-retry");
    expect(jobs).toHaveLength(3);
    expect(jobs[2]!.agentId).toBe("agent-2");
    await complete(jobs[2]!, "SUCCEEDED");
    expect(
      await prisma.tailscaleServeTemplate.findUnique({
        where: { id: "template-1" },
      }),
    ).toBeNull();
  });
});
