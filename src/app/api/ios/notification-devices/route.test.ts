import { beforeEach, describe, expect, test, vi } from "vitest";

const registerDevice = vi.hoisted(() => vi.fn());
const requireUserRequest = vi.hoisted(() => vi.fn());

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    notificationsService: { registerDevice },
  }),
}));
vi.mock("@/services/auth", () => ({ requireUserRequest }));

import { POST, resetNotificationDeviceRateLimitsForTests } from "./route";

const input = {
  clientRegistrationId: "installation-1",
  token: "01".repeat(32),
  tokenEncoding: "HEX",
  topic: "com.example.app",
  environment: "SANDBOX",
  displayName: "Test iPhone",
};

function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/ios/notification-devices", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.4",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  registerDevice.mockReset();
  requireUserRequest.mockResolvedValue(null);
  resetNotificationDeviceRateLimitsForTests();
});

describe("POST /api/ios/notification-devices", () => {
  test.each([
    [true, 201],
    [false, 200],
  ])("returns the correct status for created=%s", async (created, status) => {
    registerDevice.mockResolvedValue({
      created,
      device: {
        id: "device-1",
        status: "ACTIVE",
        lastRegisteredAt: new Date("2026-08-02T12:00:00Z"),
      },
    });

    const response = await POST(request());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: "device-1",
      created,
      status: "ACTIVE",
      lastRegisteredAt: "2026-08-02T12:00:00.000Z",
    });
    expect(registerDevice).toHaveBeenCalledWith(input, "203.0.113.4");
  });

  test("enforces content type and the 32 KiB limit", async () => {
    expect(
      (await POST(request(input, { "content-type": "text/plain" }))).status,
    ).toBe(415);
    expect(
      (await POST(request("{}", { "content-length": String(32 * 1024 + 1) })))
        .status,
    ).toBe(413);
    expect(registerDevice).not.toHaveBeenCalled();
  });

  test("reports a rejected registration as a 400 with its reason", async () => {
    registerDevice.mockRejectedValue(new Error("token is invalid"));

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "token is invalid" });
  });

  test("limits each source IP to 120 requests per minute", async () => {
    registerDevice.mockResolvedValue({
      created: false,
      device: {
        id: "device-1",
        status: "ACTIVE",
        lastRegisteredAt: new Date(),
      },
    });

    for (let index = 0; index < 120; index += 1) {
      expect((await POST(request())).status).toBe(200);
    }
    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(registerDevice).toHaveBeenCalledTimes(120);
  });

  test("keeps its rate-limit budget separate from the push console", async () => {
    const { POST: pushPost, resetApnsRegistrationRateLimitsForTests } =
      await import("../apns-devices/route");
    resetApnsRegistrationRateLimitsForTests();
    registerDevice.mockResolvedValue({
      created: false,
      device: {
        id: "device-1",
        status: "ACTIVE",
        lastRegisteredAt: new Date(),
      },
    });

    for (let index = 0; index < 120; index += 1) {
      expect((await POST(request())).status).toBe(200);
    }
    expect((await POST(request())).status).toBe(429);

    // The push console's own budget is untouched, so its 415 guard still runs.
    expect(
      (
        await pushPost(
          new Request("http://localhost/api/ios/apns-devices", {
            method: "POST",
            headers: {
              "content-type": "text/plain",
              "x-forwarded-for": "203.0.113.4",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(415);
  });
});
