import { beforeEach, describe, expect, test, vi } from "vitest";

const register = vi.hoisted(() => vi.fn());

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    pushNotificationsService: { register },
  }),
}));

import { POST, resetApnsRegistrationRateLimitsForTests } from "./route";

const input = {
  clientRegistrationId: "installation-1",
  token: "01".repeat(32),
  tokenEncoding: "HEX",
  topic: "com.example.app",
  environment: "SANDBOX",
  supportedPushTypes: ["alert", "background"],
  displayName: "Test iPhone",
};

function request(body: unknown = input, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/ios/apns-devices", {
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
  register.mockReset();
  resetApnsRegistrationRateLimitsForTests();
});

describe("POST /api/ios/apns-devices", () => {
  test.each([
    [true, 201],
    [false, 200],
  ])("returns the correct status for created=%s", async (created, status) => {
    register.mockResolvedValue({
      created,
      registration: {
        id: "registration-1",
        status: "ACTIVE",
        lastRegisteredAt: new Date("2026-07-20T12:00:00Z"),
      },
    });
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: "registration-1",
      created,
      status: "ACTIVE",
      lastRegisteredAt: "2026-07-20T12:00:00.000Z",
    });
    expect(register).toHaveBeenCalledWith(input, "203.0.113.4");
  });

  test("enforces content type and the 32 KiB limit", async () => {
    expect(
      (await POST(request(input, { "content-type": "text/plain" }))).status,
    ).toBe(415);
    expect(
      (await POST(request("{}", { "content-length": String(32 * 1024 + 1) })))
        .status,
    ).toBe(413);
    expect(register).not.toHaveBeenCalled();
  });

  test("limits each source IP to 120 requests per minute", async () => {
    register.mockResolvedValue({
      created: false,
      registration: {
        id: "registration-1",
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
    expect(register).toHaveBeenCalledTimes(120);
  });
});
