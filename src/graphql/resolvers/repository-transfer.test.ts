import { describe, expect, test, vi } from "vitest";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { RepositoryTransferService } from "@/services/repository-transfer/repository-transfer.service";
import { createRepositoryTransferResolvers } from "./repository-transfer";
describe("repository transfer resolvers", () => {
  test("agent credentials cannot preview, apply, clone, or subscribe", () => {
    const service = {
      preview: vi.fn(),
      apply: vi.fn(),
      sync: vi.fn(),
      clones: { subscribe: vi.fn() },
    } as unknown as RepositoryTransferService;
    const r = createRepositoryTransferResolvers(service);
    const context = { agentId: "agent" } as GraphQLContext;
    expect(() =>
      r.Query.previewRepositoryTransfer(
        null,
        { input: { payload: {} } },
        context,
      ),
    ).toThrow("control-plane");
    expect(() =>
      r.Mutation.applyRepositoryTransfer(
        null,
        { input: { payload: {} }, fingerprint: "hash", requestId: "request" },
        context,
      ),
    ).toThrow("control-plane");
    expect(() =>
      r.Mutation.syncAppRepositories(
        null,
        {
          appId: "app",
          destinations: [],
          fingerprint: "hash",
          requestId: "request",
        },
        context,
      ),
    ).toThrow("control-plane");
    expect(() =>
      r.Subscription.repositoryTransferChanged.subscribe(
        null,
        { operationId: "operation" },
        context,
      ),
    ).toThrow("control-plane");
    expect(service.apply).not.toHaveBeenCalled();
  });
  test("subscription IDs are resolved into durable operation progress", async () => {
    const operation = { id: "operation", status: "RUNNING" };
    const read = vi.fn().mockResolvedValue(operation);
    const r = createRepositoryTransferResolvers({
      clones: { read },
    } as unknown as RepositoryTransferService);
    await expect(
      r.Subscription.repositoryTransferChanged.resolve({
        repositoryTransferChanged: "operation",
      }),
    ).resolves.toEqual(operation);
    expect(read).toHaveBeenCalledWith("operation");
  });
});
