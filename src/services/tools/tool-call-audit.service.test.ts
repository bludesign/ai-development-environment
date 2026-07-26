import { describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  hashToolArguments,
  ToolCallAuditService,
} from "./tool-call-audit.service";

describe("tool-call auditing", () => {
  test("hashes canonical arguments without retaining their values", async () => {
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({ toolCallAudit: { create, update } });
    const service = new ToolCallAuditService();

    await expect(
      service.execute(
        {
          caller: "browser:local",
          correlationId: "request-1",
          source: "TOOLS_PAGE",
          groupId: "builtin:test",
          toolName: "test_tool",
          arguments: { token: "super-secret", nested: { b: 2, a: 1 } },
        },
        async () => ({ ok: true }),
      ),
    ).resolves.toEqual({ ok: true });

    const persisted = create.mock.calls[0]![0].data;
    expect(persisted.argumentsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain("super-secret");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resultStatus: "SUCCEEDED" }),
      }),
    );
    expect(hashToolArguments({ b: 2, a: 1 })).toBe(
      hashToolArguments({ a: 1, b: 2 }),
    );
  });

  test("records failed result status and preserves the original error", async () => {
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({ toolCallAudit: { create, update } });
    const service = new ToolCallAuditService();
    const failure = new Error("failed");

    await expect(
      service.execute(
        {
          caller: "workflow:run-1",
          correlationId: "attempt-1",
          source: "WORKFLOW",
          groupId: "builtin:test",
          toolName: "test_tool",
          arguments: {},
        },
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resultStatus: "FAILED" }),
      }),
    );
  });

  test("preserves a successful result when completion persistence fails", async () => {
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockRejectedValue(new Error("database is locked"));
    getPrismaClient.mockResolvedValue({ toolCallAudit: { create, update } });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const service = new ToolCallAuditService();

    await expect(
      service.execute(
        {
          caller: "workflow:run-1",
          correlationId: "attempt-1",
          source: "WORKFLOW",
          groupId: "builtin:github",
          toolName: "update_pull_request",
          arguments: {},
        },
        async () => ({ pullRequest: { id: "pr-1" } }),
      ),
    ).resolves.toEqual({ pullRequest: { id: "pr-1" } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resultStatus: "SUCCEEDED" }),
      }),
    );
    consoleError.mockRestore();
  });

  test("clears completed records while preserving running calls", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    getPrismaClient.mockResolvedValue({ toolCallAudit: { deleteMany } });
    const service = new ToolCallAuditService();

    await expect(service.clear()).resolves.toEqual({ count: 3 });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { resultStatus: { not: "RUNNING" } },
    });
  });
});
