import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { SseService } from "./sse.service";

describe("SseService safety limits", () => {
  beforeEach(() => mocks.getPrismaClient.mockReset());

  test.each([
    { name: "byte limit", data: "123456", sequence: 0, bytes: 5, records: 100 },
    { name: "record limit", data: "", sequence: 2, bytes: 100, records: 2 },
  ])(
    "stops persisting events at the $name",
    async ({ data, sequence, bytes, records }) => {
      const create = vi.fn();
      const update = vi.fn(async () => undefined);
      const transaction = {
        sseRequestHistory: {
          findUniqueOrThrow: vi.fn(async () => ({
            storedBytes: 0,
            truncated: false,
            firstEventAt: null,
          })),
          update,
        },
        sseHistoryEvent: { create },
      };
      mocks.getPrismaClient.mockResolvedValue({
        $transaction: async (
          operation: (value: typeof transaction) => unknown,
        ) => operation(transaction),
      });

      const result = await new SseService().appendHistoryEvent({
        requestId: "request-1",
        sequence,
        logicalIndex: sequence,
        stage: "SOURCE",
        correlationId: "correlation-1",
        eventName: "message",
        data,
        limitBytes: bytes,
        limitRecords: records,
        endpointId: "endpoint-1",
        mode: "FORWARD",
      });

      expect(result).toBeNull();
      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        where: { id: "request-1" },
        data: { truncated: true },
      });
    },
  );

  test("rejects bodyless mock statuses before resolving a composition", async () => {
    mocks.getPrismaClient.mockResolvedValue({});

    await expect(
      new SseService().resolveCompositionInput("endpoint-1", {
        name: "No content",
        statusCode: 204,
        blocks: [],
      }),
    ).rejects.toThrow("permits a response body");
  });

  test("requires filters before scanning more than the search row cap", async () => {
    const findMany = vi.fn();
    mocks.getPrismaClient.mockResolvedValue({
      sseRequestHistory: {
        count: vi.fn(async () => 10_001),
        findMany,
      },
    });

    await expect(
      new SseService().history({ view: "STREAMS", search: "needle" }),
    ).rejects.toThrow("scans at most 10,000 records");
    expect(findMany).not.toHaveBeenCalled();
  });

  test("compiles regex searches with RE2", async () => {
    mocks.getPrismaClient.mockResolvedValue({
      sseRequestHistory: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(),
      },
    });

    await expect(
      new SseService().history({
        view: "STREAMS",
        search: String.raw`(a)\1`,
        searchMode: "REGEX",
      }),
    ).rejects.toThrow(/RE2 syntax|could not be compiled/);
  });
});
