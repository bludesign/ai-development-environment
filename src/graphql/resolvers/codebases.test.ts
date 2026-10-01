import { describe, expect, test, vi } from "vitest";

import type { CodebasesService } from "@/services/codebases";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createCodebaseResolvers } from "./codebases";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

describe("codebase Git management resolvers", () => {
  test("keeps cleanup on the control plane and exposes only validated cached local inventory", async () => {
    const service = {
      deleteBranches: vi.fn().mockResolvedValue({ jobs: [], skipped: [] }),
    } as unknown as CodebasesService;
    const resolvers = createCodebaseResolvers(service);
    const input = {
      requestId: "request",
      targets: [
        {
          codebaseId: "checkout",
          branch: "local",
          expectedHeadSha: "a".repeat(40),
        },
      ],
    };
    expect(() =>
      resolvers.Mutation.deleteCodebaseBranches(
        {},
        { input },
        context("agent"),
      ),
    ).toThrow("cannot perform control-plane operations");
    await expect(
      resolvers.Mutation.deleteCodebaseBranches({}, { input }, context(null)),
    ).resolves.toEqual({ jobs: [], skipped: [] });
    expect(service.deleteBranches).toHaveBeenCalledWith(input);
    expect(
      resolvers.Codebase.localBranchInventory({
        localBranchInventoryJson: "not-json",
      }),
    ).toBeNull();
    expect(
      resolvers.Codebase.localBranchInventory({
        localBranchInventoryJson: JSON.stringify({
          scannedAt: "2026-10-01T00:00:00Z",
          branches: [],
        }),
      }),
    ).toEqual({ scannedAt: "2026-10-01T00:00:00.000Z", branches: [] });
  });
  test("exposes write preparation contents as base64 for repository editing", () => {
    const resolvers = createCodebaseResolvers({} as CodebasesService);

    expect(
      resolvers.RepositoryPreparation.contentBase64({
        contents: Uint8Array.from([0, 1, 2, 255]),
      }),
    ).toBe("AAEC/w==");
    expect(
      resolvers.RepositoryPreparation.contentBase64({ contents: null }),
    ).toBeNull();
  });

  test("exposes detail, live inspection, and operation scheduling to the control plane", async () => {
    const service = {
      detail: vi.fn().mockResolvedValue({ id: "codebase-1" }),
      inspectGitState: vi.fn().mockResolvedValue({ branches: [], stashes: [] }),
      inspectStash: vi.fn().mockResolvedValue({ patch: "diff" }),
      runGitOperation: vi.fn().mockResolvedValue({ id: "job-1" }),
    } as unknown as CodebasesService;
    const resolvers = createCodebaseResolvers(service);

    await expect(
      resolvers.Query.codebase({}, { id: "codebase-1" }, context(null)),
    ).resolves.toEqual({ id: "codebase-1" });
    await expect(
      resolvers.Mutation.inspectCodebaseGitState(
        {},
        { input: { codebaseId: "codebase-1", requestId: "request-1" } },
        context(null),
      ),
    ).resolves.toEqual({ branches: [], stashes: [] });
    await expect(
      resolvers.Mutation.inspectCodebaseStash(
        {},
        {
          input: {
            codebaseId: "codebase-1",
            stashOid: "a".repeat(40),
            requestId: "request-2",
          },
        },
        context(null),
      ),
    ).resolves.toEqual({ patch: "diff" });
    await expect(
      resolvers.Mutation.runCodebaseGitOperation(
        {},
        {
          input: {
            codebaseId: "codebase-1",
            operation: "SWITCH_BRANCH",
            branch: "feature/detail",
            requestId: "request-3",
          },
        },
        context(null),
      ),
    ).resolves.toEqual({ id: "job-1" });

    expect(service.inspectStash).toHaveBeenCalledWith(
      "codebase-1",
      "a".repeat(40),
      "request-2",
    );
    expect(service.runGitOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "SWITCH_BRANCH" }),
    );
  });

  test("rejects agent credentials for every control-plane Git action", () => {
    const service = {} as CodebasesService;
    const resolvers = createCodebaseResolvers(service);
    const agent = context("agent-1");

    expect(() =>
      resolvers.Query.codebase({}, { id: "codebase-1" }, agent),
    ).toThrow("cannot perform control-plane operations");
    expect(() =>
      resolvers.Mutation.inspectCodebaseGitState(
        {},
        { input: { codebaseId: "codebase-1", requestId: "request-1" } },
        agent,
      ),
    ).toThrow("cannot perform control-plane operations");
  });
});
