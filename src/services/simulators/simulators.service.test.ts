// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SIMULATOR_ACTION_JOB_KIND,
  SIMULATOR_CREATE_JOB_KIND,
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_JOB_KINDS,
} from "@ai-development-environment/agent-contract/simulators";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { AgentControlService } from "@/services/agent-control";
import {
  isWorkflowSimulatorJob,
  SimulatorsService,
} from "./simulators.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

const readyAgent = "ready-agent";
const otherAgent = "other-agent";
const simulator = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const clone = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const mcp = { source: "MCP" } as const;
const agentControl = new AgentControlService();
const service = new SimulatorsService(agentControl);

let directory: string;
let prisma: PrismaClient;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-simulator-service-"));
  const path = join(directory, "test.db");
  const database = new Database(":memory:");
  try {
    const migrations = "prisma/migrations";
    for (const { name } of readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((first, second) => first.name.localeCompare(second.name))) {
      database.exec(
        readFileSync(join(migrations, name, "migration.sql"), "utf8"),
      );
    }
    await database.backup(path);
  } finally {
    database.close();
  }
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  getPrismaClient.mockResolvedValue(prisma);
  for (const id of [readyAgent, otherAgent]) {
    await prisma.agent.create({
      data: {
        id,
        name: id,
        hostname: id,
        secretHash: id,
        version: "test",
        osVersion: "test",
        architecture: "arm64",
        capabilitiesJson: JSON.stringify([
          ...SIMULATOR_JOB_KINDS,
          "operation.resources.v1",
        ]),
        lastSeenAt: id === readyAgent ? new Date() : null,
      },
    });
  }
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("recovers the same automation job and rejects changed payloads", async () => {
  const enqueue = (name: string) =>
    service.enqueue(
      readyAgent,
      "create-1",
      SIMULATOR_CREATE_JOB_KIND,
      { name, runtimeId: "runtime", deviceTypeId: "type" },
      mcp,
    );
  const [job, duplicate] = await Promise.all([
    enqueue("Apple TV"),
    enqueue(" Apple TV "),
  ]);
  expect(duplicate.id).toBe(job.id);
  expect(
    await prisma.agentJob.count({
      where: { idempotencyKey: job.idempotencyKey },
    }),
  ).toBe(1);
  await expect(enqueue("iPhone")).rejects.toThrow("different payload");
  await expect(
    service.enqueue(
      readyAgent,
      "create-1",
      SIMULATOR_INVENTORY_JOB_KIND,
      {},
      mcp,
    ),
  ).rejects.toThrow("different payload");
});

test.each([
  { source: "MCP", callerKind: "api-key" },
  { source: "WORKFLOW", callerKind: "run" },
] as const)(
  "isolates $callerKind request IDs and replays within each scope",
  async ({ source, callerKind }) => {
    const requestId = `shared-${callerKind}-request`;
    const firstCaller = { source, requestScope: [callerKind, "first"] };
    const secondCaller = { source, requestScope: [callerKind, "second"] };
    const enqueue = () =>
      service.enqueue(
        readyAgent,
        requestId,
        SIMULATOR_INVENTORY_JOB_KIND,
        {},
        firstCaller,
      );
    const deleteSelected = () =>
      service.deleteSelected(
        [{ agentId: readyAgent, simulatorId: simulator }],
        requestId,
        secondCaller,
      );

    const inventoryJob = await enqueue();
    const deletion = await deleteSelected();
    expect(deletion.targets[0]?.jobId).toEqual(expect.any(String));
    expect(deletion.targets[0]?.jobId).not.toBe(inventoryJob.id);
    expect(isWorkflowSimulatorJob(inventoryJob)).toBe(source === "WORKFLOW");
    expect((await enqueue()).id).toBe(inventoryJob.id);
    expect(await deleteSelected()).toEqual(deletion);
  },
);

test("recovers partial deletion batches across agents and rejects changed targets", async () => {
  const first = { agentId: readyAgent, simulatorId: simulator };
  const second = { agentId: otherAgent, simulatorId: simulator };
  const result = await service.deleteSelected(
    [first, { ...first, simulatorId: simulator.toLowerCase() }, second],
    "delete-1",
    mcp,
  );
  expect(result.targets).toEqual([
    { ...first, jobId: expect.any(String), status: "QUEUED", error: null },
    { ...second, jobId: null, status: null, error: `${otherAgent} is offline` },
  ]);
  await expect(
    service.deleteSelected([first], "delete-1", mcp),
  ).rejects.toThrow("different payload");

  await prisma.agent.update({
    where: { id: otherAgent },
    data: { lastSeenAt: new Date() },
  });
  const retry = await new SimulatorsService(agentControl).deleteSelected(
    [second, first],
    "delete-1",
    mcp,
  );
  expect(retry.targets[0]).toMatchObject({
    ...second,
    jobId: expect.any(String),
  });
  expect(retry.targets[1]).toEqual(result.targets[0]);
  expect(await agentControl.getJob(retry.targets[0]!.jobId!)).toMatchObject({
    kind: SIMULATOR_ACTION_JOB_KIND,
    payloadJson: JSON.stringify({ simulatorId: simulator, action: "DELETE" }),
  });
});

test("stops admitting deletion jobs when the caller cancels submission", async () => {
  const first = { agentId: readyAgent, simulatorId: simulator };
  const second = { agentId: readyAgent, simulatorId: clone };
  const shouldStopSubmitting = vi
    .fn()
    .mockReturnValueOnce(false)
    .mockReturnValue(true);

  const result = await service.deleteSelected(
    [first, second],
    "delete-stopped",
    { source: "WORKFLOW" },
    shouldStopSubmitting,
  );

  expect(shouldStopSubmitting).toHaveBeenCalledTimes(2);
  expect(result.targets).toEqual([
    { ...first, jobId: expect.any(String), status: "QUEUED", error: null },
  ]);
});

test("limits reads to the requested agent and projects typed simulator results", async () => {
  const job = await service.enqueue(
    readyAgent,
    "inspect-1",
    SIMULATOR_INSPECT_JOB_KIND,
    { simulatorId: simulator.toLowerCase() },
    mcp,
  );
  await expect(service.getJob(otherAgent, job.id)).rejects.toThrow(
    "Simulator job not found",
  );
  const details = {
    simulator: {
      id: simulator,
      name: "Apple TV",
      runtimeId: "runtime",
      runtimeName: "tvOS",
      platform: "tvOS",
      deviceTypeId: "type",
      state: "Booted",
      isAvailable: true,
      availabilityError: null,
      dataPath: null,
    },
    apps: [
      {
        bundleId: "com.example.app",
        name: "Example",
        version: null,
        build: null,
        bundlePath: null,
        dataPath: null,
      },
    ],
  };
  await agentControl.completeJob(
    readyAgent,
    job.id,
    "SUCCEEDED",
    { details },
    null,
  );
  await expect(service.getJob(readyAgent, job.id)).resolves.toMatchObject({
    status: "SUCCEEDED",
    operation: "INSPECT",
    simulatorId: simulator,
    details,
  });
  await expect(
    service.getJobs([
      { agentId: otherAgent, jobId: job.id },
      { agentId: readyAgent, jobId: "missing" },
      { agentId: readyAgent, jobId: job.id },
    ]),
  ).resolves.toEqual([expect.objectContaining({ jobId: job.id, details })]);
});

test("marks workflow origin internally and reports the new clone UUID", async () => {
  const action = { action: "CLONE", simulatorId: simulator, name: "Copy" };
  const job = await service.enqueue(
    readyAgent,
    "clone-1",
    SIMULATOR_ACTION_JOB_KIND,
    action,
    { source: "WORKFLOW" },
  );
  const publicJob = await service.enqueue(
    readyAgent,
    job.idempotencyKey,
    SIMULATOR_ACTION_JOB_KIND,
    action,
  );
  expect(isWorkflowSimulatorJob(job)).toBe(true);
  expect(isWorkflowSimulatorJob(publicJob)).toBe(false);
  await agentControl.completeJob(
    readyAgent,
    job.id,
    "SUCCEEDED",
    { simulatorId: clone },
    null,
  );
  await expect(service.getJob(readyAgent, job.id)).resolves.toMatchObject({
    status: "SUCCEEDED",
    operation: "CLONE",
    simulatorId: clone,
  });
});
