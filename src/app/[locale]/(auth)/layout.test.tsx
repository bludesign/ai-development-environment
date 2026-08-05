import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/services/auth", () => ({
  getAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));

import AuthLayout from "./layout";

describe("authentication layout", () => {
  test("renders sign-in for a stale session cookie", async () => {
    const requestHeaders = new Headers({
      cookie: "better-auth.session_token=revoked-token",
    });
    mocks.headers.mockResolvedValue(requestHeaders);
    mocks.getSession.mockResolvedValue(null);

    const child = <p>Sign in</p>;
    await expect(
      AuthLayout({
        children: child,
        params: Promise.resolve({ locale: "en" }),
      }),
    ).resolves.toBe(child);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  test("redirects a valid session away from authentication pages", async () => {
    mocks.headers.mockResolvedValue(new Headers());
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });

    await AuthLayout({
      children: <p>Sign in</p>,
      params: Promise.resolve({ locale: "fr" }),
    });

    expect(mocks.redirect).toHaveBeenCalledWith("/fr");
  });
});
