import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  intl: vi.fn(() => new Response("intl")),
}));

vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => mocks.intl),
}));

import proxy, { config } from "@/proxy";

function request(path: string, headers?: HeadersInit): NextRequest {
  return new NextRequest(`https://control.example.com${path}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authentication and locale proxy", () => {
  test.each([
    "/api/auth/config",
    "/api/auth/sign-in/email",
    "/api/public/github/webhook",
    "/api/openapi.json",
    "/api/telemetry/analytics-events",
    "/api/telemetry/console-logs",
    "/api/ios/apns-devices",
    "/api/graphql",
    "/api/mcp",
    "/api/agent/run-attachments/file-1",
    "/api/build-artifact-uploads/upload-1",
    "/api/codebases",
    "/api/tools/catalog",
    "/api/ios/notification-devices",
    "/api/ios/enrollment/start",
    "/api/ios/devices/export.tsv",
    "/api/telemetry/export",
  ])("leaves API authorization to the route handler for %s", async (path) => {
    const response = await proxy(request(path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("redirects an anonymous dashboard request with a safe return path", async () => {
    const response = await proxy(request("/en/builds?status=running"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://control.example.com/en/sign-in?returnTo=%2Fen%2Fbuilds%3Fstatus%3Drunning",
    );
  });

  test("keeps localized sign-in and registration pages public", async () => {
    await expect(proxy(request("/en/sign-in"))).resolves.toHaveProperty(
      "status",
      200,
    );
    await expect(proxy(request("/fr/register"))).resolves.toHaveProperty(
      "status",
      200,
    );
    expect(mocks.intl).toHaveBeenCalledTimes(2);
  });

  test("lets auth pages validate an optimistic session cookie", async () => {
    const response = await proxy(
      request("/en/sign-in", {
        cookie: "better-auth.session_token=session-token",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.intl).toHaveBeenCalledOnce();
  });

  test("excludes APIs, GraphQL WebSockets, framework assets, and files", () => {
    expect(config.matcher).toEqual([
      "/((?!api|graphql|_next|_vercel|.*\\..*).*)",
    ]);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig: {},
        url: "/graphql",
      }),
    ).toBe(false);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        nextConfig: {},
        url: "/en/worktrees",
      }),
    ).toBe(true);
  });
});
