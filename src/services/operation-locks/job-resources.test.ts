import { beforeEach, describe, expect, test, vi } from "vitest";
import { operationDescriptorsConflict } from "@ai-development-environment/agent-contract/operation-resources";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import { jobOperationDescriptor, type JobResourceInput } from "./job-resources";

function registered(id = "a", codebaseId = "repository", agentId = "builder") {
  return {
    id,
    codebaseId,
    gitDirectory: `/repo/.git/worktrees/${id}`,
    folder: `/worktrees/${id}`,
    branch: `feature/${id}`,
    codebase: {
      agentId,
      repository: { canonicalOrigin: "github.com/example/app" },
    },
  };
}

const a = registered();
const b = registered("b");
const findFirst = vi.fn();
function job(
  kind: string,
  payload: Record<string, unknown> = {},
  worktreeId: string | null = "a",
): JobResourceInput {
  const worktree = worktreeId === "b" ? b : a;
  return {
    agentId: "builder",
    codebaseId: "repository",
    worktreeId,
    kind,
    payload: {
      ...(worktreeId
        ? { folder: worktree.folder, gitDirectory: worktree.gitDirectory }
        : {}),
      ...payload,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockImplementation(
    async ({ where }) =>
      [a, b].find((worktree) =>
        where.id
          ? worktree.id === where.id
          : where.gitDirectory
            ? worktree.gitDirectory === where.gitDirectory
            : worktree.folder === where.folder,
      ) ?? null,
  );
  getPrismaClient.mockResolvedValue({ worktree: { findFirst } });
});

describe("job execution resource derivation", () => {
  test("allows sibling builds and sibling Git mutations while protecting the building checkout", async () => {
    const buildA = await jobOperationDescriptor(
      job("ios.build.run", {
        artifactDirectory: "/Builds/build-a",
        derivedDataPath: "/Builds/.worktree-derived-data/a",
        action: "BUILD",
        scripts: [],
      }),
      true,
    );
    const buildB = await jobOperationDescriptor(
      job(
        "ios.build.run",
        {
          artifactDirectory: "/Builds/build-b",
          derivedDataPath: "/Builds/.worktree-derived-data/b",
          action: "BUILD",
          scripts: [],
        },
        "b",
      ),
      true,
    );
    const gitA = await jobOperationDescriptor(
      job("worktree.git.operation", { operation: "STAGE_ALL" }),
      true,
    );
    const gitB = await jobOperationDescriptor(
      job("worktree.auto-sync", {}, "b"),
      true,
    );
    expect(operationDescriptorsConflict(buildA, buildB)).toBe(false);
    expect(operationDescriptorsConflict(buildA, gitB)).toBe(false);
    expect(operationDescriptorsConflict(buildA, gitA)).toBe(true);
    expect(buildA.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "WORKTREE", mode: "BUILD" }),
        expect.objectContaining({
          kind: "PATH",
          path: "/Builds/.worktree-derived-data/a",
          mode: "WRITE",
        }),
        expect.objectContaining({
          kind: "BRANCH",
          mode: "INTENT",
          key: "branch:github.com/example/app:feature/a",
        }),
      ]),
    );
  });

  test.each([
    "worktree.inspect",
    "worktree.git.inspect",
    "worktree.diff.inspect",
    "worktree.diff.asset",
    "ios.source.discover",
    "ios.source.parse",
    "ios.signing.inspect",
    "ios.destinations.inspect",
    "codebase.inspect",
    "codebase.refresh",
  ])("classifies %s as source inspection", async (kind) => {
    const descriptor = await jobOperationDescriptor(job(kind), true);
    expect(descriptor.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "WORKTREE", mode: "READ" }),
        expect.objectContaining({ kind: "PATH", path: a.folder, mode: "READ" }),
      ]),
    );
    expect(descriptor.resources.every(({ mode }) => mode === "READ")).toBe(
      true,
    );
  });

  test.each([
    "codebase.fetch",
    "codebase.branches.delete",
    "buildData.scan",
    "jira.branch.generate",
    "worktree.watch",
  ])("leaves short phased %s coordination to the agent", async (kind) => {
    expect((await jobOperationDescriptor(job(kind), true)).resources).toEqual(
      ["worktree.watch", "jira.branch.generate"].includes(kind)
        ? []
        : [
            expect.objectContaining({
              kind: "METADATA",
              mode: "INTENT",
              agentId: "builder",
              codebaseId: "repository",
            }),
          ],
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  test("leaves artifact operations independent of source checkouts and scopes them to their paths", async () => {
    const exportA = await jobOperationDescriptor(
      job("ios.archive.export", { artifactDirectory: "/Builds/a" }),
      true,
    );
    const downloadB = await jobOperationDescriptor(
      job("ios.artifact.download", { artifactDirectory: "/Builds/b" }),
      true,
    );
    expect(exportA.resources).toEqual([
      expect.objectContaining({
        kind: "PATH",
        path: "/Builds/a",
        mode: "WRITE",
      }),
    ]);
    expect(operationDescriptorsConflict(exportA, downloadB)).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  test("reserves physical/simulator destinations for tests and deployment, not compilation or generic destinations", async () => {
    const destination = { id: "SIM-1", generic: false };
    const testBuild = await jobOperationDescriptor(
      job("ios.build.run", { action: "TEST", destination }),
      true,
    );
    const deployment = await jobOperationDescriptor(
      job(
        "ios.build.deploy",
        {
          deployments: [{ id: "deployment", destination }],
          artifactDirectory: "/Builds/previous",
        },
        "b",
      ),
      true,
    );
    expect(operationDescriptorsConflict(testBuild, deployment)).toBe(true);
    for (const payload of [
      { action: "BUILD", destination },
      { action: "TEST", destination: { ...destination, generic: true } },
    ])
      expect(
        (
          await jobOperationDescriptor(job("ios.build.run", payload), true)
        ).resources.some(({ kind }) => kind === "DESTINATION"),
      ).toBe(false);
  });

  test("reserves every destination in remote deployment batches without a source checkout", async () => {
    const remote = await jobOperationDescriptor(
      {
        agentId: "builder",
        kind: "ios.build.remoteDeploy",
        payload: {
          buildId: "build",
          transferId: "transfer",
          deployments: [
            { id: "one", destination: { id: "SIM-1", type: "SIMULATOR" } },
            {
              id: "two",
              destination: { id: "PHONE-1", type: "PHYSICAL_DEVICE" },
            },
          ],
        },
      },
      true,
    );
    expect(remote.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "DESTINATION",
          key: "builder:destination:SIMULATOR:SIM-1",
          mode: "WRITE",
        }),
        expect.objectContaining({
          kind: "DESTINATION",
          key: "builder:destination:PHYSICAL_DEVICE:PHONE-1",
          mode: "WRITE",
        }),
      ]),
    );
    expect(remote.resources).toHaveLength(2);
  });

  test.each(["ios.test-results.parse", "ios.coverage.generate"])(
    "protects generated report writes for %s",
    async (kind) => {
      expect(
        (
          await jobOperationDescriptor(
            job(kind, { artifactDirectory: "/Builds/report" }),
            true,
          )
        ).resources,
      ).toEqual([
        expect.objectContaining({
          kind: "PATH",
          path: "/Builds/report",
          mode: "WRITE",
        }),
      ]);
    },
  );

  test("acquires all preparation targets and both branch-switch identities", async () => {
    const preparations = await jobOperationDescriptor(
      job(
        "worktree.prepare",
        {
          action: "APPLY",
          worktrees: [a, b].map(({ id: worktreeId, folder, gitDirectory }) => ({
            worktreeId,
            folder,
            gitDirectory,
          })),
        },
        null,
      ),
      true,
    );
    expect(
      preparations.resources.filter(({ kind }) => kind === "WORKTREE"),
    ).toHaveLength(2);
    const change = await jobOperationDescriptor(
      job("worktree.branch", {
        action: "CHANGE",
        branch: "feature/new",
        candidates: ["feature/candidate"],
      }),
      true,
    );
    expect(
      change.resources
        .filter(({ kind }) => kind === "BRANCH")
        .map(({ key }) => key),
    ).toEqual(
      expect.arrayContaining([
        "branch:github.com/example/app:feature/a",
        "branch:github.com/example/app:feature/new",
        "branch:github.com/example/app:feature/candidate",
      ]),
    );
  });

  test("keeps configured nonblocking commands compatible and scopes blocking commands to their checkout", async () => {
    for (const kind of ["command.run", "workflow.terminal.run"]) {
      expect(
        (
          await jobOperationDescriptor(
            { ...job(kind), blocksGitOperations: false },
            true,
          )
        ).resources,
      ).toEqual([]);
      expect(
        (
          await jobOperationDescriptor(
            { ...job(kind), blocksGitOperations: false },
            false,
          )
        ).resources,
      ).toEqual([]);
      expect(
        (
          await jobOperationDescriptor(
            { ...job(kind), blocksGitOperations: true },
            true,
          )
        ).resources,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "WORKTREE", mode: "WRITE" }),
        ]),
      );
    }
  });

  test("uses an agent barrier for explicitly blocking home scripts with no source target", async () => {
    const input: JobResourceInput = {
      agentId: "builder",
      kind: "command.run",
      blocksGitOperations: true,
      payload: { targetKind: "AGENT_HOME", cwd: null },
    };
    expect((await jobOperationDescriptor(input, true)).resources).toEqual([
      expect.objectContaining({ kind: "AGENT", mode: "WRITE" }),
    ]);
  });

  test.each(["WORKTREE", "CODEBASE", "AGENT"] as const)(
    "honors %s build-hook scope",
    async (lockScope) => {
      const descriptor = await jobOperationDescriptor(
        job("ios.build.run", { scripts: [{ lockScope }] }),
        true,
      );
      expect(descriptor.resources.some(({ kind }) => kind === "CODEBASE")).toBe(
        lockScope === "CODEBASE",
      );
      expect(descriptor.resources.some(({ kind }) => kind === "AGENT")).toBe(
        lockScope === "AGENT",
      );
    },
  );

  test("uses conservative barriers for old agents and missing identities, and rejects mismatched identities", async () => {
    expect(
      (await jobOperationDescriptor(job("ios.build.run"), false)).resources,
    ).toEqual([expect.objectContaining({ kind: "CODEBASE", mode: "WRITE" })]);
    findFirst.mockResolvedValueOnce(null);
    expect(
      (await jobOperationDescriptor(job("worktree.commit"), true)).resources,
    ).toEqual([expect.objectContaining({ kind: "CODEBASE", mode: "WRITE" })]);
    await expect(
      jobOperationDescriptor(
        job("worktree.commit", { folder: "/wrong-worktree" }),
        true,
      ),
    ).rejects.toThrow("registered worktree");
  });

  test("coordinates cleanup and size inspection using the actual managed/legacy target paths", async () => {
    const payload = {
      targets: [
        {
          path: "/Builds/.worktree-derived-data/a",
          rootPath: "/Builds/.worktree-derived-data",
        },
      ],
    };
    const cleanup = await jobOperationDescriptor(
      job("buildData.delete", payload, null),
      true,
    );
    const size = await jobOperationDescriptor(
      job("buildData.size", payload, null),
      true,
    );
    expect(cleanup.resources).toEqual([
      expect.objectContaining({
        kind: "PATH",
        path: payload.targets[0]!.path,
        mode: "WRITE",
      }),
    ]);
    expect(size.resources).toEqual([
      expect.objectContaining({ kind: "PATH", mode: "READ" }),
    ]);
    expect(operationDescriptorsConflict(cleanup, size)).toBe(true);
  });
});
