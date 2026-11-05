import { buildASTSchema, execute, parse, subscribe, validate } from "graphql";
import { schemaDefinitions } from "@/generated/schema-definitions";
import { agentEventBus, buildTopic } from "@/services/agent-control";
import { describe, expect, test, vi } from "vitest";

import type { BuildsService } from "@/services/builds";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createBuildResolvers } from "./builds";

const context = (agentId: string | null) => ({ agentId }) as GraphQLContext;

describe("build resolver authorization", () => {
  test("updates iOS project defaults only on the control plane", async () => {
    const service = {
      updateProject: vi.fn().mockResolvedValue({
        id: "project-1",
        defaultDestinationType: "PHYSICAL_DEVICE",
      }),
    } as unknown as BuildsService;
    const mutation = createBuildResolvers(service).Mutation;
    const input = {
      id: "project-1",
      defaultDestinationType: "PHYSICAL_DEVICE",
    };
    expect(() =>
      mutation.updateIosAppProject({}, input, context("agent-1")),
    ).toThrow("cannot perform control-plane operations");
    expect(service.updateProject).not.toHaveBeenCalled();
    await expect(
      mutation.updateIosAppProject({}, input, context(null)),
    ).resolves.toEqual(input);
    expect(service.updateProject).toHaveBeenCalledWith(
      "project-1",
      "PHYSICAL_DEVICE",
    );
  });

  test("resolves report relations and lazily selected report data", async () => {
    const service = {
      getBuild: vi.fn().mockResolvedValue({ id: "build-1" }),
      reportsForBuild: vi.fn().mockResolvedValue([{ id: "report-1" }]),
      reportData: vi.fn().mockResolvedValue('{"files":[{"path":"App.swift"}]}'),
    } as unknown as BuildsService;
    const resolvers = createBuildResolvers(service);

    await expect(
      resolvers.BuildReport.build({ buildId: "build-1" }),
    ).resolves.toEqual({ id: "build-1" });
    await expect(resolvers.Build.reports({ id: "build-1" })).resolves.toEqual([
      { id: "report-1" },
    ]);
    await expect(
      resolvers.BuildReport.coverageFiles({
        id: "report-1",
        kind: "CODE_COVERAGE",
      }),
    ).resolves.toEqual([{ path: "App.swift" }]);
    expect(service.getBuild).toHaveBeenCalledWith("build-1");
    expect(service.reportData).toHaveBeenCalledWith("report-1");
  });

  test("defaults per-line coverage for reports recorded without it", async () => {
    const service = {
      reportData: vi.fn().mockResolvedValue(
        JSON.stringify({
          changedFiles: [
            // Written before per-line coverage existed.
            { path: "Legacy.swift", changedLineCoverage: 0.5 },
            {
              path: "Current.swift",
              coveredLineNumbers: [2, 4],
              uncoveredLineNumbers: [3],
            },
            // A malformed list must not reach the non-null schema field.
            { path: "Broken.swift", coveredLineNumbers: "nope" },
          ],
        }),
      ),
    } as unknown as BuildsService;
    const resolvers = createBuildResolvers(service);

    await expect(
      resolvers.BuildReport.changedCoverageFiles({
        id: "report-1",
        kind: "CODE_COVERAGE",
      }),
    ).resolves.toEqual([
      {
        path: "Legacy.swift",
        changedLineCoverage: 0.5,
        coveredLineNumbers: [],
        uncoveredLineNumbers: [],
      },
      {
        path: "Current.swift",
        coveredLineNumbers: [2, 4],
        uncoveredLineNumbers: [3],
      },
      {
        path: "Broken.swift",
        coveredLineNumbers: [],
        uncoveredLineNumbers: [],
      },
    ]);
  });

  test("keeps build configuration and execution operations on the control plane", async () => {
    const service = {
      builds: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      startBuild: vi.fn().mockResolvedValue({ id: "build-1" }),
      rebuildBuild: vi.fn().mockResolvedValue({ id: "build-2" }),
    } as unknown as BuildsService;
    const resolvers = createBuildResolvers(service);

    expect(() =>
      resolvers.Query.builds({}, {} as never, context("agent-1")),
    ).toThrow("cannot perform control-plane operations");
    expect(() =>
      resolvers.Query.buildBranches({}, {} as never, context("agent-1")),
    ).toThrow("cannot perform control-plane operations");
    expect(() =>
      resolvers.Mutation.startBuild(
        {},
        { input: { requestId: "request-1" } as never },
        context("agent-1"),
      ),
    ).toThrow("cannot perform control-plane operations");
    await expect(
      resolvers.Mutation.startBuild(
        {},
        { input: { requestId: "request-1" } as never },
        context(null),
      ),
    ).resolves.toEqual({ id: "build-1" });
    expect(() =>
      resolvers.Mutation.rebuildBuild(
        {},
        { id: "build-1", requestId: "request-2" },
        context("agent-1"),
      ),
    ).toThrow("cannot perform control-plane operations");
    await expect(
      resolvers.Mutation.rebuildBuild(
        {},
        { id: "build-1", requestId: "request-2" },
        context(null),
      ),
    ).resolves.toEqual({ id: "build-2" });
  });

  test("accepts progress and sanitized log reports only from authenticated agents", async () => {
    const service = {
      reportProgress: vi.fn().mockResolvedValue({ id: "build-1" }),
      appendLogChunks: vi.fn().mockResolvedValue([{ sequence: 0 }]),
    } as unknown as BuildsService;
    const mutation = createBuildResolvers(service).Mutation;

    expect(() =>
      mutation.reportBuildProgress(
        {},
        { input: { buildId: "build-1", status: "RUNNING" } as never },
        context(null),
      ),
    ).toThrow("Agent authentication is required");
    await expect(
      mutation.appendBuildLogChunks(
        {},
        {
          buildId: "build-1",
          chunks: [{ sequence: 0, dataBase64: "eA==" }] as never,
        },
        context("agent-1"),
      ),
    ).resolves.toEqual([{ sequence: 0 }]);
    expect(service.appendLogChunks).toHaveBeenCalledWith("agent-1", "build-1", [
      { sequence: 0, dataBase64: "eA==" },
    ]);
  });
});

test.each([
  { name: "legacy", scriptExecutions: undefined },
  {
    name: "live scripts",
    scriptExecutions: [
      {
        phase: "PRE_BUILD",
        position: 0,
        status: "FAILED",
        exitCode: 1,
        durationMs: 150,
        causedBuildFailure: false,
        outputRelativePath: "hooks/pre/000-script-1.log",
        error: "Optional hook failed",
      },
    ],
  },
])(
  "accepts $name build progress through GraphQL",
  async ({ scriptExecutions }) => {
    const service = {
      reportProgress: vi.fn().mockResolvedValue({ id: "build-1" }),
    } as unknown as BuildsService;
    const resolvers = createBuildResolvers(service);
    const schema = buildASTSchema(parse(schemaDefinitions.join("\n")), {
      assumeValidSDL: true,
    });
    Object.assign(schema.getMutationType()!.getFields().reportBuildProgress, {
      resolve: resolvers.Mutation.reportBuildProgress,
    });
    const input = {
      buildId: "build-1",
      status: "RUNNING",
      ...(scriptExecutions ? { scriptExecutions } : {}),
    };
    const result = await execute({
      schema,
      document: parse(`
        mutation ReportBuildProgress($input: BuildProgressInput!) {
          reportBuildProgress(input: $input) { id }
        }
      `),
      variableValues: { input },
      contextValue: context("agent-1"),
    });
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ reportBuildProgress: { id: "build-1" } });
    expect(service.reportProgress).toHaveBeenCalledWith("agent-1", input);
  },
);

test("executes the additive full build snapshot subscription while retaining the legacy invalidation", async () => {
  const service = {
    getBuild: vi.fn().mockResolvedValue({ id: "build-1", status: "SUCCEEDED" }),
  } as unknown as BuildsService;
  const resolvers = createBuildResolvers(service);
  const schema = buildASTSchema(parse(schemaDefinitions.join("\n")), {
    assumeValidSDL: true,
  });
  for (const name of ["buildSnapshotChanged", "buildChanged"] as const)
    Object.assign(
      schema.getSubscriptionType()!.getFields()[name],
      resolvers.Subscription[name],
    );
  expect(
    validate(
      schema,
      parse(
        'subscription { buildSnapshotChanged(id: "build-1") { id status } }',
      ),
    ),
  ).toEqual([]);
  const stream = await subscribe({
    schema,
    document: parse(
      'subscription { buildSnapshotChanged(id: "build-1") { id status } }',
    ),
    contextValue: context(null),
  });
  if (!(Symbol.asyncIterator in stream))
    throw new Error(JSON.stringify(stream));
  const next = stream.next();
  agentEventBus.publish(buildTopic("build-1"), {
    buildChanged: { id: "build-1" },
  });
  const value = await next;
  if (value.done) throw new Error("Snapshot subscription ended");
  expect(value.value.errors).toBeUndefined();
  expect(value.value.data).toEqual({
    buildSnapshotChanged: { id: "build-1", status: "SUCCEEDED" },
  });
  expect(service.getBuild).toHaveBeenCalledTimes(1);
  await stream.return?.();
  const legacy = await subscribe({
    schema,
    document: parse('subscription { buildChanged(id: "build-1") { id } }'),
    contextValue: context(null),
  });
  if (!(Symbol.asyncIterator in legacy))
    throw new Error(JSON.stringify(legacy));
  const legacyNext = legacy.next();
  agentEventBus.publish(buildTopic("build-1"), {
    buildChanged: { id: "build-1" },
  });
  const legacyValue = await legacyNext;
  if (legacyValue.done) throw new Error("Legacy subscription ended");
  expect(legacyValue.value.data).toEqual({
    buildChanged: { id: "build-1" },
  });
  expect(service.getBuild).toHaveBeenCalledTimes(1);
  await legacy.return?.();
});
