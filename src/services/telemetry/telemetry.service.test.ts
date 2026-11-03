// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { agentEventBus } from "@/services/agent-control";

import { TelemetryService, detectTelemetryOrigins } from "./telemetry.service";

const settings = {
  id: "default",
  localBaseUrlOverride: null,
  remoteBaseUrlOverride: null,
  consoleCollectionEnabled: true,
  analyticsCollectionEnabled: true,
  createdAt: new Date("2026-07-20T16:00:00Z"),
  updatedAt: new Date("2026-07-20T16:00:00Z"),
};

function raw(
  id: string,
  entryType: "CONSOLE" | "ANALYTICS" | "SEPARATOR",
  clientTime: string,
) {
  return {
    id,
    entryType,
    clientTime: new Date(clientTime),
    receivedAt: new Date(clientTime),
    deviceIp: entryType === "SEPARATOR" ? null : "203.0.113.7",
    message: entryType === "CONSOLE" ? `message ${id}` : null,
    level: entryType === "CONSOLE" ? "info" : null,
    category: entryType === "CONSOLE" ? "test" : null,
    eventName: entryType === "ANALYTICS" ? `event ${id}` : null,
    eventKind: entryType === "ANALYTICS" ? "product" : null,
    screenName: entryType === "ANALYTICS" ? "Home" : null,
    buildId: "build-1",
    sessionId: entryType === "SEPARATOR" ? null : "session-1",
    attributesJson: entryType === "CONSOLE" ? '{"nested":{"value":1}}' : "{}",
    defaultParametersJson: entryType === "ANALYTICS" ? '{"version":"1"}' : "{}",
    additionalParametersJson: "{}",
    searchText: "",
    highlightColor: null,
    separatorKind: entryType === "SEPARATOR" ? "MANUAL" : null,
    separatorName: entryType === "SEPARATOR" ? "Boundary" : null,
    createdAt: new Date(clientTime),
    updatedAt: new Date(clientTime),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("TelemetryService", () => {
  test("shows successful runs before telemetry arrives and paginates consecutive runs without duplicates", async () => {
    const first = {
      ...raw("run-first", "SEPARATOR", "2026-07-20T16:40:00Z"),
      separatorKind: "BUILD_RUN",
    };
    const second = {
      ...raw("run-second", "SEPARATOR", "2026-07-20T16:39:00Z"),
      separatorKind: "BUILD_RUN",
    };
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([second])
      .mockResolvedValueOnce([first, second]);
    getPrismaClient.mockResolvedValue({
      telemetryEntry: { count: vi.fn().mockResolvedValue(0), findMany },
    });
    const service = new TelemetryService();
    const page = await service.timeline({ view: "ANALYTICS", first: 1 });
    expect(page.items.map((entry) => entry.id)).toEqual([first.id]);
    expect(page.matchingCount).toBe(0);
    expect(page.nextCursor).toBeTruthy();
    const next = await service.timeline({
      view: "ANALYTICS",
      first: 1,
      after: page.nextCursor,
    });
    expect(next.items.map((entry) => entry.id)).toEqual([second.id]);
    expect(next.nextCursor).toBeNull();
    expect(
      (
        await service.timeline({
          view: "ANALYTICS",
          showBuildRunSeparators: false,
        })
      ).items,
    ).toEqual([]);
  });
  test("returns first-seen metadata scoped to retained events in the requested view", async () => {
    const firstSeenAt = new Date("2026-07-20T08:00:00Z");
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([
        { buildId: "build-z", _min: { clientTime: firstSeenAt } },
        { buildId: "", _min: { clientTime: firstSeenAt } },
        { buildId: "build-a", _min: { clientTime: firstSeenAt } },
      ])
      .mockResolvedValueOnce([
        { sessionId: "session-1", _min: { clientTime: firstSeenAt } },
      ]);
    getPrismaClient.mockResolvedValue({ telemetryEntry: { groupBy } });
    expect(await new TelemetryService().idFacets("ANALYTICS")).toEqual({
      buildIds: [
        { value: "build-a", firstSeenAt: firstSeenAt.toISOString() },
        { value: "build-z", firstSeenAt: firstSeenAt.toISOString() },
      ],
      sessionIds: [
        { value: "session-1", firstSeenAt: firstSeenAt.toISOString() },
      ],
    });
    expect(groupBy).toHaveBeenCalledWith({
      by: ["buildId"],
      where: { entryType: { in: ["ANALYTICS"] }, buildId: { not: null } },
      _min: { clientTime: true },
    });
  });

  test.each([undefined, "message"])(
    "hides only run separators with search %s",
    async (search) => {
      const rows = [
        raw("log-new", "CONSOLE", "2026-07-20T16:40:00Z"),
        {
          ...raw("run", "SEPARATOR", "2026-07-20T16:39:00Z"),
          separatorKind: "BUILD_RUN",
        },
        raw("log-middle", "CONSOLE", "2026-07-20T16:38:00Z"),
        {
          ...raw("created", "SEPARATOR", "2026-07-20T16:37:00Z"),
          separatorKind: "BUILD_CREATED",
        },
        raw("log-old", "CONSOLE", "2026-07-20T16:36:00Z"),
        raw("manual", "SEPARATOR", "2026-07-20T16:35:00Z"),
      ];
      getPrismaClient.mockResolvedValue({
        telemetryEntry: {
          count: vi.fn().mockResolvedValue(3),
          findMany: vi.fn().mockResolvedValue(rows),
        },
      });
      const service = new TelemetryService();
      const hidden = await service.timeline({
        view: "CONSOLE",
        search,
        showBuildRunSeparators: false,
      });
      expect(hidden.items.map((entry) => entry.id)).toEqual([
        "log-new",
        "log-middle",
        "created",
        "log-old",
        "manual",
      ]);
      expect(hidden.matchingCount).toBe(3);
      const visible = await service.timeline({ view: "CONSOLE", search });
      expect(visible.items.map((entry) => entry.id)).toContain("run");
    },
  );
  test.each(
    [undefined, "message"].flatMap((search) =>
      [undefined, true, false].map((showBuildRunSeparators) => ({
        search,
        showBuildRunSeparators,
      })),
    ),
  )(
    "exports visible separators with search $search and run visibility $showBuildRunSeparators",
    async ({ search, showBuildRunSeparators }) => {
      const rows = [
        raw("log-new", "CONSOLE", "2026-07-20T16:40:00Z"),
        {
          ...raw("run", "SEPARATOR", "2026-07-20T16:39:00Z"),
          separatorKind: "BUILD_RUN",
        },
        raw("log-middle", "CONSOLE", "2026-07-20T16:38:00Z"),
        {
          ...raw("created", "SEPARATOR", "2026-07-20T16:37:00Z"),
          separatorKind: "BUILD_CREATED",
        },
        raw("log-old", "CONSOLE", "2026-07-20T16:36:00Z"),
        raw("manual", "SEPARATOR", "2026-07-20T16:35:00Z"),
      ];
      getPrismaClient.mockResolvedValue({
        telemetryEntry: { findMany: vi.fn().mockResolvedValue(rows) },
      });
      const entries = await new TelemetryService().exportEntries({
        query: { view: "CONSOLE", search, showBuildRunSeparators },
        selection: null,
      });
      expect(entries.map((entry) => entry.id)).toEqual(
        showBuildRunSeparators === false
          ? ["log-new", "log-middle", "created", "log-old", "manual"]
          : rows.map((entry) => entry.id),
      );
    },
  );
  test.each(["MANUAL", "BUILD_CREATED"])(
    "keeps a matching export segment across a hidden run before a %s separator",
    async (separatorKind) => {
      const rows = [
        raw("log", "CONSOLE", "2026-07-20T16:40:00Z"),
        {
          ...raw("run", "SEPARATOR", "2026-07-20T16:39:00Z"),
          separatorKind: "BUILD_RUN",
        },
        {
          ...raw("boundary", "SEPARATOR", "2026-07-20T16:38:00Z"),
          separatorKind,
        },
      ];
      getPrismaClient.mockResolvedValue({
        telemetryEntry: { findMany: vi.fn().mockResolvedValue(rows) },
      });
      const entries = await new TelemetryService().exportEntries({
        query: {
          view: "CONSOLE",
          search: "message",
          showBuildRunSeparators: false,
        },
      });
      expect(entries.map((entry) => entry.id)).toEqual(["log", "boundary"]);
    },
  );
  test("detects reachability-aware local and remote origins", () => {
    expect(
      detectTelemetryOrigins({
        requestOrigin: "http://127.0.0.1:3000",
        localOrigins: ["http://192.168.1.20:3000"],
        publicBaseUrl: "https://events.example.com/path",
      }),
    ).toEqual({
      local: "http://127.0.0.1:3000",
      remote: "https://events.example.com",
    });
    expect(
      detectTelemetryOrigins({
        requestOrigin: "https://events.example.com",
        localOrigins: ["http://192.168.1.20:3000"],
      }).local,
    ).toBe("http://192.168.1.20:3000");
  });

  test("atomically creates enriched console batches and publishes one change", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    getPrismaClient.mockResolvedValue({
      telemetrySettings: { upsert: vi.fn().mockResolvedValue(settings) },
      telemetryEntry: { createMany },
    });
    const publish = vi.spyOn(agentEventBus, "publish");
    const result = await new TelemetryService().ingestConsole(
      [
        {
          message: "first",
          time: "2026-07-20T16:30:00.000Z",
          level: "info",
          category: "test",
          buildId: "build-1",
          sessionId: "session-1",
          attributes: { nested: { value: 1 } },
        },
        {
          message: "second",
          time: "2026-07-20T16:30:01.000Z",
          level: "debug",
          category: "test",
          buildId: "build-1",
          sessionId: "session-1",
          attributes: {},
        },
      ],
      "203.0.113.7",
    );
    expect(result.collected).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          entryType: "CONSOLE",
          deviceIp: "203.0.113.7",
          searchText: expect.stringContaining("nested.value"),
        }),
      ]),
    });
    expect(publish).toHaveBeenCalledWith(
      "telemetry.changed",
      expect.objectContaining({ reason: "INGESTED" }),
    );
  });

  test("validates but drops analytics when collection is disabled", async () => {
    getPrismaClient.mockResolvedValue({
      telemetrySettings: {
        upsert: vi.fn().mockResolvedValue({
          ...settings,
          analyticsCollectionEnabled: false,
        }),
      },
      telemetryEntry: { createMany: vi.fn() },
    });
    await expect(
      new TelemetryService().ingestAnalytics(
        [
          {
            eventName: "opened",
            kind: "product",
            screenName: "Home",
            time: "2026-07-20T16:30:00.000Z",
            defaultParameters: {},
            additionalParameters: {},
            buildId: "build-1",
            sessionId: "session-1",
          },
        ],
        "203.0.113.7",
      ),
    ).resolves.toEqual({ collected: false, items: [] });
  });

  test("returns exact filtered counts, a stable cursor, and useful separators", async () => {
    const logs = [
      raw("log-2", "CONSOLE", "2026-07-20T16:32:00Z"),
      raw("log-1", "CONSOLE", "2026-07-20T16:30:00Z"),
    ];
    const separator = raw("separator-1", "SEPARATOR", "2026-07-20T16:31:00Z");
    const findMany = vi.fn().mockResolvedValue([logs[0], separator, logs[1]]);
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count: vi.fn().mockResolvedValue(2),
        findMany,
      },
    });
    const page = await new TelemetryService().timeline({
      view: "CONSOLE",
      first: 1,
      search: "message",
    });
    expect(page).toMatchObject({ matchingCount: 2, totalCount: 2 });
    expect(page.items.map(({ id }) => id)).toEqual(["log-2", "separator-1"]);
    expect(page.nextCursor).toEqual(expect.any(String));

    const full = await new TelemetryService().timeline({
      view: "CONSOLE",
      first: 2,
      search: "message",
    });
    expect(full.items.map(({ id }) => id)).toEqual([
      "log-2",
      "separator-1",
      "log-1",
    ]);
  });

  test("stops an unfiltered timeline scan after the page look-ahead row", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 1_000 }, (_, index) =>
          raw(`log-${index}`, "CONSOLE", "2026-07-20T16:30:00Z"),
        ),
      );
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count: vi.fn().mockResolvedValue(1_000),
        findMany,
      },
    });

    const page = await new TelemetryService().timeline({
      view: "CONSOLE",
      first: 1,
    });

    expect(page.items.map(({ id }) => id)).toEqual(["log-0"]);
    expect(page).toMatchObject({ matchingCount: 1_000, totalCount: 1_000 });
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  test("does not duplicate a trailing separator on the next unfiltered page", async () => {
    const newer = raw("log-2", "CONSOLE", "2026-07-20T16:32:00Z");
    const separator = raw("separator-1", "SEPARATOR", "2026-07-20T16:31:00Z");
    const older = raw("log-1", "CONSOLE", "2026-07-20T16:30:00Z");
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([newer, separator])
      .mockResolvedValueOnce([older])
      .mockResolvedValueOnce([separator, older])
      .mockResolvedValueOnce([]);
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count: vi.fn().mockResolvedValue(2),
        findMany,
      },
    });
    const service = new TelemetryService();

    const firstPage = await service.timeline({ view: "CONSOLE", first: 1 });
    const secondPage = await service.timeline({
      view: "CONSOLE",
      first: 1,
      after: firstPage.nextCursor,
    });

    expect(firstPage.items.map(({ id }) => id)).toEqual([
      "log-2",
      "separator-1",
    ]);
    expect(secondPage.items.map(({ id }) => id)).toEqual(["log-1"]);
  });

  test("fetches only entries strictly newer than the latest separator", async () => {
    const separator = raw("separator-1", "SEPARATOR", "2026-07-20T16:31:00Z");
    const newer = raw("log-2", "CONSOLE", "2026-07-20T16:32:00Z");
    const count = vi.fn().mockResolvedValue(1);
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count,
        findFirst: vi.fn().mockResolvedValue(separator),
        findMany: vi.fn().mockResolvedValue([newer]),
      },
    });

    const page = await new TelemetryService().timelineSinceLatestSeparator({
      view: "CONSOLE",
      first: 50,
    });

    expect(page.separator?.id).toBe("separator-1");
    expect(page.items.map(({ id }) => id)).toEqual(["log-2"]);
    expect(page).toMatchObject({ matchingCount: 1, totalCount: 1 });
    expect(count).toHaveBeenCalledWith({
      where: {
        AND: [
          { entryType: { in: ["CONSOLE"] } },
          {
            OR: [
              { clientTime: { gt: separator.clientTime } },
              {
                clientTime: separator.clientTime,
                receivedAt: { gt: separator.receivedAt },
              },
              {
                clientTime: separator.clientTime,
                receivedAt: separator.receivedAt,
                id: { gt: separator.id },
              },
            ],
          },
        ],
      },
    });
  });

  test("uses the complete separator ordering for same-time entries", async () => {
    const separator = raw("separator-m", "SEPARATOR", "2026-07-20T16:31:00Z");
    const newer = raw("separator-z", "CONSOLE", "2026-07-20T16:31:00Z");
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count: vi.fn().mockResolvedValue(1),
        findFirst: vi.fn().mockResolvedValue(separator),
        findMany: vi.fn().mockResolvedValue([newer]),
      },
    });

    const page = await new TelemetryService().timelineSinceLatestSeparator({
      view: "CONSOLE",
    });

    expect(page.items.map(({ id }) => id)).toEqual(["separator-z"]);
  });

  test("treats a missing separator as an unbounded recent segment", async () => {
    const entry = raw("log-1", "CONSOLE", "2026-07-20T16:31:00Z");
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count: vi.fn().mockResolvedValue(1),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([entry]),
      },
    });

    const page = await new TelemetryService().timelineSinceLatestSeparator({
      view: "CONSOLE",
    });

    expect(page.separator).toBeNull();
    expect(page.items.map(({ id }) => id)).toEqual(["log-1"]);
  });

  test("stops an unfiltered separator timeline after its look-ahead row", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 1_000 }, (_, index) =>
          raw(`log-${index}`, "CONSOLE", "2026-07-20T16:31:00Z"),
        ),
      );
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count: vi.fn().mockResolvedValue(1_000),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany,
      },
    });

    const page = await new TelemetryService().timelineSinceLatestSeparator({
      view: "CONSOLE",
      first: 1,
    });

    expect(page.items.map(({ id }) => id)).toEqual(["log-0"]);
    expect(page).toMatchObject({ matchingCount: 1_000, totalCount: 1_000 });
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });

  test("pushes supported timeline filters into the database scan", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([raw("log-1", "CONSOLE", "2026-07-20T16:30:00Z")]);
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        count: vi.fn().mockResolvedValue(10),
        findMany,
      },
    });

    await new TelemetryService().timeline({
      view: "CONSOLE",
      quickFilters: { level: ["info"] },
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { entryType: "SEPARATOR" },
            {
              AND: [
                { entryType: { in: ["CONSOLE"] } },
                { level: { in: ["info"] } },
              ],
            },
          ],
        },
      }),
    );
  });

  test("clears only chronologically older source records before the latest separator", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 4 });
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            raw("separator-1", "SEPARATOR", "2026-07-20T16:31:00Z"),
          ),
        deleteMany,
      },
    });
    await expect(
      new TelemetryService().clearBeforeLatestSeparator("CONSOLE"),
    ).resolves.toBe(4);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { entryType: { in: ["CONSOLE"] } },
          {
            OR: [
              { clientTime: { lt: new Date("2026-07-20T16:31:00Z") } },
              {
                clientTime: new Date("2026-07-20T16:31:00Z"),
                receivedAt: {
                  lt: new Date("2026-07-20T16:31:00Z"),
                },
              },
              {
                clientTime: new Date("2026-07-20T16:31:00Z"),
                receivedAt: new Date("2026-07-20T16:31:00Z"),
                id: { lt: "separator-1" },
              },
            ],
          },
        ],
      },
    });
  });

  test("scopes explicit ID clears to the selected view while allowing separators", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([{ id: "console-1" }, { id: "separator-1" }]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    getPrismaClient.mockResolvedValue({
      telemetryEntry: { findMany, deleteMany },
    });

    await expect(
      new TelemetryService().clearScoped({
        view: "CONSOLE",
        scope: "IDS",
        ids: ["console-1", "analytics-1", "separator-1"],
      }),
    ).resolves.toBe(2);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["console-1", "analytics-1", "separator-1"] },
        entryType: { in: ["CONSOLE", "SEPARATOR"] },
      },
      select: { id: true },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["console-1", "separator-1"] } },
    });
  });

  test("dispatches matching and broad clear scopes without implicit separators", async () => {
    const service = new TelemetryService();
    const clearSelected = vi
      .spyOn(service, "clearSelected")
      .mockResolvedValue(3);
    const clearAll = vi.spyOn(service, "clearAll").mockResolvedValue(4);
    const clearBefore = vi
      .spyOn(service, "clearBeforeLatestSeparator")
      .mockResolvedValue(5);

    await expect(
      service.clearScoped({
        view: "ANALYTICS",
        scope: "MATCHING",
        query: { search: "checkout" },
      }),
    ).resolves.toBe(3);
    expect(clearSelected).toHaveBeenCalledWith({
      query: { view: "ANALYTICS", search: "checkout" },
    });

    await expect(
      service.clearScoped({ view: "UNIFIED", scope: "ALL" }),
    ).resolves.toBe(4);
    expect(clearAll).toHaveBeenCalledWith("UNIFIED", false);

    await expect(
      service.clearScoped({
        view: "CONSOLE",
        scope: "BEFORE_LATEST_SEPARATOR",
        includeSeparators: true,
      }),
    ).resolves.toBe(5);
    expect(clearBefore).toHaveBeenCalledWith("CONSOLE", true);
  });

  test("applies server-side query ranges to unloaded selections", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    getPrismaClient.mockResolvedValue({
      telemetryEntry: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            raw("log-2", "CONSOLE", "2026-07-20T16:32:00Z"),
            raw("separator-1", "SEPARATOR", "2026-07-20T16:31:00Z"),
            raw("log-1", "CONSOLE", "2026-07-20T16:30:00Z"),
          ]),
        deleteMany,
      },
    });
    await expect(
      new TelemetryService().clearSelected({
        ids: ["separator-1"],
        query: { view: "CONSOLE", search: "message" },
        ranges: [
          {
            startTime: "2026-07-20T16:29:00Z",
            endTime: "2026-07-20T16:31:00Z",
          },
        ],
      }),
    ).resolves.toBe(2);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: expect.arrayContaining(["separator-1", "log-1"]) } },
    });
  });
});
