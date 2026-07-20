// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeEnrollment: vi.fn(),
  createEnrollment: vi.fn(),
  enrollmentProfile: vi.fn(),
}));

const deviceId = "8bb37dd2-6e24-4ac8-8c53-c391f6c642c7";

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    iosDevicesService: mocks,
  }),
}));

import { GET as completion } from "./enrollment-complete/route";
import { GET as profile } from "./enrollment-profile/route";
import { POST as start } from "./enrollment/start/route";
import { POST as callback } from "./profile-response/route";

function proxyHeaders(extra: Record<string, string> = {}) {
  return {
    "x-forwarded-host": "devices.example.com",
    "x-forwarded-proto": "https",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.completeEnrollment.mockResolvedValue({ id: deviceId });
  mocks.enrollmentProfile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.createEnrollment.mockResolvedValue({
    id: "enrollment-1",
    token: "test-token",
    expiresAt: new Date(Date.now() + 60_000),
  });
});

describe("iOS enrollment routes", () => {
  test("serves the signed profile with Apple MIME and no-cache headers", async () => {
    const response = await profile(
      new Request(
        "http://127.0.0.1:3000/api/ios/enrollment-profile?token=test-token",
        {
          headers: proxyHeaders({ "cf-connecting-ip": "203.0.113.9" }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-apple-aspen-config",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="register-device.mobileconfig"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(mocks.enrollmentProfile).toHaveBeenCalledWith(
      "test-token",
      "https://devices.example.com",
      { address: "203.0.113.9", source: "CLOUDFLARE" },
    );
  });

  test("disables profile enrollment without HTTPS", async () => {
    const response = await profile(
      new Request(
        "http://192.168.1.20:3000/api/ios/enrollment-profile?token=test-token",
        { headers: { host: "192.168.1.20:3000" } },
      ),
    );
    expect(response.status).toBe(409);
    expect(mocks.enrollmentProfile).not.toHaveBeenCalled();
  });

  test("does not treat HTTPS on a private-address origin as publicly trusted", async () => {
    const response = await profile(
      new Request(
        "http://192.168.1.20:3000/api/ios/enrollment-profile?token=test-token",
        {
          headers: {
            "x-forwarded-host": "192.168.1.20",
            "x-forwarded-proto": "https",
          },
        },
      ),
    );
    expect(response.status).toBe(409);
    expect(mocks.enrollmentProfile).not.toHaveBeenCalled();
  });

  test("starts a consented enrollment and redirects to the public profile URL", async () => {
    const form = new FormData();
    form.set("displayName", "Test iPhone");
    form.set("consent", "yes");
    const response = await start(
      new Request("http://127.0.0.1:3000/api/ios/enrollment/start", {
        method: "POST",
        headers: proxyHeaders({ origin: "https://devices.example.com" }),
        body: form,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://devices.example.com/api/ios/enrollment-profile?token=test-token",
    );
    expect(mocks.createEnrollment).toHaveBeenCalledWith("Test iPhone");
  });

  test("rejects missing consent and cross-origin enrollment starts", async () => {
    const withoutConsent = new FormData();
    withoutConsent.set("displayName", "Test iPhone");
    const missing = await start(
      new Request("http://127.0.0.1:3000/api/ios/enrollment/start", {
        method: "POST",
        headers: proxyHeaders(),
        body: withoutConsent,
      }),
    );
    expect(missing.status).toBe(400);

    const crossOrigin = new FormData();
    crossOrigin.set("displayName", "Test iPhone");
    crossOrigin.set("consent", "yes");
    const forbidden = await start(
      new Request("http://127.0.0.1:3000/api/ios/enrollment/start", {
        method: "POST",
        headers: proxyHeaders({ origin: "https://attacker.example" }),
        body: crossOrigin,
      }),
    );
    expect(forbidden.status).toBe(403);
  });

  test("enforces the callback body limit before parsing", async () => {
    const response = await callback(
      new Request(
        "https://devices.example.com/api/ios/profile-response?token=test-token",
        {
          method: "POST",
          headers: { "content-length": String(128 * 1024 + 1) },
          body: new Uint8Array([1]),
        },
      ),
    );
    expect(response.status).toBe(413);
    expect(mocks.completeEnrollment).not.toHaveBeenCalled();
  });

  test("passes raw callback bytes and redirects to the generic completion page", async () => {
    const response = await callback(
      new Request(
        "http://127.0.0.1:3000/api/ios/profile-response?token=test-token",
        {
          method: "POST",
          headers: proxyHeaders({ "x-forwarded-for": "198.51.100.7" }),
          body: new Uint8Array([4, 5, 6]),
        },
      ),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      `https://devices.example.com/api/ios/enrollment-complete?deviceId=${deviceId}`,
    );
    expect(mocks.completeEnrollment).toHaveBeenCalledWith(
      "test-token",
      new Uint8Array([4, 5, 6]),
      { address: "198.51.100.7", source: "FORWARDED" },
    );
  });

  test("serves a script-free completion page with restrictive headers", async () => {
    const response = completion(
      new Request(
        `https://devices.example.com/api/ios/enrollment-complete?deviceId=${deviceId}`,
      ),
    );
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const html = await response.text();
    expect(html).toContain("Device received");
    expect(html).toContain(`href="/devices/${deviceId}"`);
    expect(html).toContain("View device");
  });
});
