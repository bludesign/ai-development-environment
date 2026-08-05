import { beforeEach, describe, expect, test, vi } from "vitest";

const getAuth = vi.hoisted(() => vi.fn());

vi.mock("./auth", () => ({ getAuth }));

import { resolveRequestPrincipal } from "./principal";

const verifyApiKey = vi.fn();
const getSession = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getAuth.mockResolvedValue({ api: { verifyApiKey, getSession } });
});

describe("request principal resolution", () => {
  test("returns anonymous only when no credential was supplied", async () => {
    await expect(resolveRequestPrincipal(new Headers())).resolves.toEqual({
      kind: "anonymous",
    });
  });

  test("resolves a Better Auth API key", async () => {
    verifyApiKey.mockResolvedValue({
      valid: true,
      key: {
        id: "key-1",
        referenceId: "user-1",
        name: "Automation",
      },
    });
    await expect(
      resolveRequestPrincipal(new Headers({ "x-api-key": "aide_secret" })),
    ).resolves.toEqual({
      kind: "apiKey",
      apiKeyId: "key-1",
      userId: "user-1",
      name: "Automation",
    });
  });

  test.each([
    new Headers({ authorization: "Bearer session-token" }),
    new Headers({ cookie: "better-auth.session_token=cookie-token" }),
    new Headers({ cookie: "__Secure-better-auth.session_token=cookie-token" }),
  ])("resolves a Better Auth session", async (headers) => {
    getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1", email: "user@example.com" },
    });
    await expect(resolveRequestPrincipal(headers)).resolves.toEqual({
      kind: "user",
      userId: "user-1",
      email: "user@example.com",
      sessionId: "session-1",
    });
  });

  test("resolves an existing agent credential only with an agent service", async () => {
    const agents = { authenticate: vi.fn().mockResolvedValue("agent-1") };
    await expect(
      resolveRequestPrincipal(
        new Headers({ authorization: "Bearer agent_secret" }),
        agents as never,
      ),
    ).resolves.toEqual({ kind: "agent", agentId: "agent-1" });
  });

  test("rejects conflicting credentials", async () => {
    await expect(
      resolveRequestPrincipal(
        new Headers({
          authorization: "Bearer session-token",
          "x-api-key": "aide_secret",
        }),
      ),
    ).rejects.toMatchObject({
      name: "PrincipalResolutionError",
      status: 400,
    });

    await expect(
      resolveRequestPrincipal(
        new Headers({
          authorization: "Bearer session-token",
          cookie: "better-auth.session_token=cookie-token",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("rejects invalid credentials instead of falling back to anonymous", async () => {
    verifyApiKey.mockResolvedValue({ valid: false, key: null });
    await expect(
      resolveRequestPrincipal(new Headers({ "x-api-key": "aide_bad" })),
    ).rejects.toThrow("invalid or inactive");

    getSession.mockResolvedValue(null);
    await expect(
      resolveRequestPrincipal(
        new Headers({ authorization: "Bearer expired-session" }),
      ),
    ).rejects.toThrow("invalid or expired");
  });
});
