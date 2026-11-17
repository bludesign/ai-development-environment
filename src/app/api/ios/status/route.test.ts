import { beforeEach, expect, test, vi } from "vitest";
import { resetRateLimitsForTests } from "@/lib/ios-registration-request";

const mocks = vi.hoisted(() => ({
  requireUserRequest: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("@/services/auth", () => ({
  requireUserRequest: mocks.requireUserRequest,
}));
vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ iosStatusService: { snapshot: mocks.snapshot } }),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitsForTests("ios-status");
  mocks.requireUserRequest.mockResolvedValue(null);
  mocks.snapshot.mockResolvedValue({
    usageToday: { totalCost: 12 },
    activity: { pullRequests: 2 },
  });
});

test("requires authentication before accessing the status snapshot", async () => {
  mocks.requireUserRequest.mockResolvedValue(
    new Response(null, { status: 401 }),
  );
  expect(
    (await GET(new Request("http://localhost/api/ios/status"))).status,
  ).toBe(401);
  expect(mocks.snapshot).not.toHaveBeenCalled();
});

test("returns status without permitting proxy or browser caching", async () => {
  const response = await GET(new Request("http://localhost/api/ios/status"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    usageToday: { totalCost: 12 },
    activity: { pullRequests: 2 },
  });
});
