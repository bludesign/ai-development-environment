import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  validMcpOAuthQuery: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/components/auth/auth-form", () => ({ AuthForm: () => null }));
vi.mock("@/services/auth", () => ({
  getAuth: async () => ({ api: { getSession: mocks.getSession } }),
  getAuthRuntimeConfig: () => ({ mode: "password", provider: null }),
  getRegistrationStatus: async () => ({ enabled: false, setupRequired: false }),
}));
vi.mock("@/services/auth/mcp-oauth-config", () => ({
  getMcpOAuthConfig: () => ({ origin: "https://control.example" }),
}));
vi.mock("@/services/auth/mcp-oauth-query", async (original) => ({
  ...(await original<typeof import("@/services/auth/mcp-oauth-query")>()),
  validMcpOAuthQuery: mocks.validMcpOAuthQuery,
}));

import { AuthForm } from "@/components/auth/auth-form";
import McpSignInPage from "./page";

beforeEach(() => {
  mocks.validMcpOAuthQuery.mockResolvedValue(true);
  mocks.getSession.mockResolvedValue({
    session: { createdAt: new Date(Date.now() - 3_600_000) },
  });
});

test.each(["0", "60"])(
  "shows credentials when the existing session exceeds max_age=%s",
  async (maxAge) => {
    const page = await McpSignInPage({
      searchParams: Promise.resolve({ client_id: "client", max_age: maxAge }),
    });
    expect(page.type).toBe(AuthForm);
  },
);

test("shows credentials for an explicit login prompt even with a session", async () => {
  const page = await McpSignInPage({
    searchParams: Promise.resolve({ client_id: "client", prompt: "login" }),
  });
  expect(page.type).toBe(AuthForm);
});

test("continues authorization when the existing session satisfies max_age", async () => {
  mocks.getSession.mockResolvedValue({
    session: { createdAt: new Date(Date.now() - 30_000) },
  });
  await expect(
    McpSignInPage({
      searchParams: Promise.resolve({ client_id: "client", max_age: "60" }),
    }),
  ).rejects.toMatchObject({
    digest:
      "NEXT_REDIRECT;replace;/api/auth/oauth2/authorize?client_id=client&max_age=60;307;",
  });
});

test("continues an existing session when no reauthentication was requested", async () => {
  await expect(
    McpSignInPage({ searchParams: Promise.resolve({ client_id: "client" }) }),
  ).rejects.toMatchObject({
    digest:
      "NEXT_REDIRECT;replace;/api/auth/oauth2/authorize?client_id=client;307;",
  });
});
