import { beforeEach, expect, test, vi } from "vitest";
import { resetRateLimitsForTests } from "@/lib/ios-registration-request";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  requireUserPrincipal: vi.fn(),
  crossOriginError: vi.fn(),
}));
vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ iosStatusService: mocks }),
}));
vi.mock("@/services/auth", async (original) => ({
  ...(await original<object>()),
  requireUserPrincipal: mocks.requireUserPrincipal,
  crossOriginError: mocks.crossOriginError,
}));
import { PrincipalResolutionError } from "@/services/auth";
import { POST, DELETE } from "./route";

function request(
  method = "POST",
  body: unknown = { clientRegistrationId: "widget-1" },
) {
  return new Request("http://localhost/api/ios/status-subscriptions", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitsForTests("ios-status-subscriptions");
  mocks.crossOriginError.mockReturnValue(null);
  mocks.requireUserPrincipal.mockResolvedValue({
    userId: "user-1",
    sessionId: "session-1",
  });
  mocks.register.mockResolvedValue({ id: "registration-1", status: "ACTIVE" });
  mocks.unregister.mockResolvedValue({ deleted: true });
});

test("rejects missing user authentication before reading or mutating registrations", async () => {
  mocks.requireUserPrincipal.mockRejectedValue(
    new PrincipalResolutionError("A user session is required."),
  );
  expect((await POST(request())).status).toBe(401);
  expect((await DELETE(request("DELETE"))).status).toBe(401);
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.unregister).not.toHaveBeenCalled();
});

test("blocks cross-origin cookie authentication", async () => {
  mocks.crossOriginError.mockReturnValue(new Response(null, { status: 403 }));
  expect((await POST(request())).status).toBe(403);
  expect(mocks.requireUserPrincipal).not.toHaveBeenCalled();
});

test("passes authenticated ownership to registration and deletion and prevents caching", async () => {
  const response = await POST(request());
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.register).toHaveBeenCalledWith(
    { userId: "user-1", sessionId: "session-1" },
    { clientRegistrationId: "widget-1" },
  );
  expect((await DELETE(request("DELETE"))).status).toBe(200);
  expect(mocks.unregister).toHaveBeenCalledWith(
    { userId: "user-1", sessionId: "session-1" },
    { clientRegistrationId: "widget-1" },
  );
});
