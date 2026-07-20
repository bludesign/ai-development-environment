// @vitest-environment node
import { describe, expect, test, vi } from "vitest";

import type { TelemetryService } from "@/services/telemetry";

import { createTelemetryResolvers } from "./telemetry";

describe("telemetry subscription resolvers", () => {
  test("maps raw event-bus payloads to non-null subscription fields", () => {
    const service = {
      subscribe: vi.fn(),
      subscribeSettings: vi.fn(),
    } as unknown as TelemetryService;
    const subscriptions = createTelemetryResolvers(service).Subscription;
    const entriesChanged = {
      ids: ["log-1", "event-1"],
      reason: "INGESTED",
    };
    const settingsChanged = { updatedAt: "2026-07-20T18:30:00.000Z" };

    expect(subscriptions.telemetryEntriesChanged.resolve(entriesChanged)).toBe(
      entriesChanged,
    );
    expect(
      subscriptions.telemetrySettingsChanged.resolve(settingsChanged),
    ).toBe(settingsChanged);
  });
});
