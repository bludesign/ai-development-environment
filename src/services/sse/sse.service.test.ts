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

describe("SseService parameterized templates", () => {
  beforeEach(() => mocks.getPrismaClient.mockReset());

  function templatePrisma(options?: {
    blockValues?: Array<{ fieldId: string; value: string }>;
    fields?: Array<{
      id: string;
      key: string;
      label: string;
      helpText: string;
      type: "TEXT" | "NUMBER";
      required: boolean;
      defaultValue: string | null;
    }>;
  }) {
    const now = new Date("2026-08-30T00:00:00.000Z");
    const fields = options?.fields ?? [
      {
        id: "stable-id",
        key: "name",
        label: "Name",
        helpText: "",
        type: "TEXT" as const,
        required: true,
        defaultValue: null,
      },
    ];
    const existing = {
      id: "template-1",
      endpointId: "endpoint-1",
      name: "Greeting",
      eventName: null,
      data: "{{name}}",
      eventId: null,
      retryMs: null,
      retryMsTemplate: null,
      fieldsJson: JSON.stringify(fields),
      createdAt: now,
      updatedAt: now,
    };
    const update = vi.fn(async () => undefined);
    const upsert = vi.fn(async ({ update: data }) => ({
      ...existing,
      ...data,
      updatedAt: now,
    }));
    const transaction = {
      sseMockBlock: {
        findMany: vi.fn(async () =>
          options?.blockValues
            ? [
                {
                  id: "block-1",
                  templateValuesJson: JSON.stringify(options.blockValues),
                },
              ]
            : [],
        ),
        update,
      },
      sseMockEventTemplate: { upsert },
    };
    const prisma = {
      sseEndpoint: { findUnique: vi.fn(async () => ({ id: "endpoint-1" })) },
      sseMockEventTemplate: { findUnique: vi.fn(async () => existing) },
      $transaction: vi.fn(
        async (operation: (value: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    };
    return { prisma, transaction, update, upsert };
  }

  test("preserves definitions when an older client omits fields", async () => {
    const { prisma, upsert } = templatePrisma();
    mocks.getPrismaClient.mockResolvedValue(prisma);

    const result = await new SseService().saveEventTemplate("endpoint-1", {
      id: "template-1",
      name: "Greeting",
      data: "Hello {{name}}",
    });

    expect(result.fields).toHaveLength(1);
    expect(result.fields[0]?.id).toBe("stable-id");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          fieldsJson: expect.stringContaining('"stable-id"'),
        }),
      }),
    );
  });

  test("keeps values through key renames and prunes removed fields", async () => {
    const { prisma, update } = templatePrisma({
      fields: [
        {
          id: "stable-id",
          key: "name",
          label: "Name",
          helpText: "",
          type: "TEXT",
          required: true,
          defaultValue: null,
        },
        {
          id: "removed-id",
          key: "title",
          label: "Title",
          helpText: "",
          type: "TEXT",
          required: false,
          defaultValue: null,
        },
      ],
      blockValues: [
        { fieldId: "stable-id", value: "Ada" },
        { fieldId: "removed-id", value: "Countess" },
      ],
    });
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new SseService().saveEventTemplate("endpoint-1", {
      id: "template-1",
      name: "Greeting",
      data: "Hello {{customer}}",
      fields: [
        {
          id: "stable-id",
          key: "customer",
          label: "Customer",
          type: "TEXT",
          required: true,
        },
      ],
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: "block-1" },
      data: {
        templateValuesJson: JSON.stringify([
          { fieldId: "stable-id", value: "Ada" },
        ]),
      },
    });
  });

  test("rejects incompatible referenced field type changes transactionally", async () => {
    const { prisma, upsert } = templatePrisma({
      blockValues: [{ fieldId: "stable-id", value: "Ada" }],
    });
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await expect(
      new SseService().saveEventTemplate("endpoint-1", {
        id: "template-1",
        name: "Greeting",
        data: "{{count}}",
        fields: [
          {
            id: "stable-id",
            key: "count",
            label: "Count",
            type: "NUMBER",
            required: true,
          },
        ],
      }),
    ).rejects.toThrow("finite number");
    expect(upsert).not.toHaveBeenCalled();
  });

  test("prevents deleting a referenced template", async () => {
    const deleteMany = vi.fn();
    const transaction = {
      sseMockEventTemplate: {
        findUnique: vi.fn(async () => ({
          id: "template-1",
          endpointId: "endpoint-1",
        })),
        deleteMany,
      },
      sseMockBlock: { count: vi.fn(async () => 1) },
    };
    mocks.getPrismaClient.mockResolvedValue({
      $transaction: vi.fn(
        async (operation: (value: typeof transaction) => unknown) =>
          operation(transaction),
      ),
    });

    await expect(
      new SseService().deleteEventTemplate("template-1"),
    ).rejects.toThrow("cannot be deleted");
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
