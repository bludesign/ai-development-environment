import createMiddleware from "next-intl/middleware";
import { describe, expect, test, vi } from "vitest";

import proxy, { config } from "@/proxy";
import { routing } from "@/i18n/routing";

const mocks = vi.hoisted(() => ({
  handler: vi.fn(),
}));

vi.mock("next-intl/middleware", () => ({
  default: vi.fn(() => mocks.handler),
}));

describe("locale proxy", () => {
  test("creates the locale handler from the shared routing configuration", () => {
    expect(createMiddleware).toHaveBeenCalledWith(routing);
    expect(proxy).toBe(mocks.handler);
  });

  test("excludes APIs, GraphQL, Next.js internals, and static files", () => {
    expect(config.matcher).toEqual([
      "/((?!api|graphql|trpc|_next|_vercel|.*\\..*).*)",
    ]);
  });
});
