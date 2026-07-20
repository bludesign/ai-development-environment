// @vitest-environment node
import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_TELEMETRY_ADDRESS,
  mockTelemetryPayloads,
  sendMockTelemetry,
  telemetryAddress,
} from "./send-mock-telemetry";

describe("send-mock-telemetry", () => {
  test("accepts positional and named addresses with a loopback default", () => {
    expect(telemetryAddress([])).toBe(DEFAULT_TELEMETRY_ADDRESS);
    expect(telemetryAddress(["http://192.168.1.20:3000/"])).toBe(
      "http://192.168.1.20:3000",
    );
    expect(telemetryAddress(["--address=https://events.example.com"])).toBe(
      "https://events.example.com",
    );
    expect(() => telemetryAddress(["https://example.com/path"])).toThrow(
      "without a path",
    );
  });

  test("sends one valid console log and analytics event per tick", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ collected: true, items: [] }), {
        status: 201,
      }),
    );
    await sendMockTelemetry(
      "http://127.0.0.1:3000",
      4,
      "mock-session",
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/telemetry/console-logs",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(
          '"message":"Mock console log 4: the simulated debug operation',
        ),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/telemetry/analytics-events",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"eventName":"mock_event_4"'),
      }),
    );
    expect(mockTelemetryPayloads(1, "session").consoleLog.sessionId).toBe(
      "session",
    );
  });
});
