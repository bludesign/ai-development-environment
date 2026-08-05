import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    user: { findUnique: mocks.findUser },
  }),
}));
vi.mock("@/services/auth", () => ({
  getAuth: async () => ({ api: { createApiKey: mocks.createApiKey } }),
}));
vi.mock("../http", () => ({
  authenticated: async (
    _request: Request,
    action: (principal: {
      kind: "user";
      userId: string;
      email: string;
      sessionId: string;
    }) => Promise<unknown>,
  ) =>
    Response.json(
      await action({
        kind: "user",
        userId: "operator-1",
        email: "operator@example.com",
        sessionId: "session-1",
      }),
    ),
}));

import { POST } from "./route";

describe("API-key management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue({ id: "owner-2" });
    mocks.createApiKey.mockResolvedValue({ id: "key-1", key: "aide_secret" });
  });

  test("uses server-side creation for the selected owner", async () => {
    const response = await POST(
      new Request("https://control.example.com/api/auth/management/api-keys", {
        method: "POST",
        headers: {
          authorization: "Bearer operator-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "owner-2",
          name: "Deployment automation",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.createApiKey).toHaveBeenCalledWith({
      body: {
        userId: "owner-2",
        name: "Deployment automation",
        expiresIn: null,
      },
    });
  });
});
