import { describe, expect, test, vi } from "vitest";

import type { BuildsService } from "@/services/builds";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createBuildResolvers } from "./builds";

const context = (agentId: string | null) => ({ agentId }) as GraphQLContext;

describe("build resolver authorization", () => {
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
