import { describe, expect, test, vi } from "vitest";

vi.mock("@/services/auth", () => ({
  getAuthRuntimeConfig: () => ({ mode: "password", provider: null }),
  getRegistrationStatus: async () => ({ enabled: false, setupRequired: false }),
}));

import { GET } from "./route";

describe("public auth configuration", () => {
  test("advertises nearby sign-in without changing existing auth fields", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({
      mode: "password",
      registration: { enabled: false, setupRequired: false },
      provider: null,
      nearbySignInEnabled: true,
    });
  });
});
