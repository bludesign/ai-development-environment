import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CacheServerSettingsCard } from "./settings-card";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("CacheServerSettingsCard", () => {
  test("explains where configured connection values and proxy headers come from", async () => {
    request.mockResolvedValue({
      cacheServerSettings: {
        configured: true,
        baseUrl: "https://cache.example.com/management-api",
        apiKeyConfigured: true,
        headers: [{ name: "X-Proxy-Token", valueConfigured: true }],
        updatedAt: new Date(0).toISOString(),
      },
    } as never);

    render(<CacheServerSettingsCard />);

    expect(
      await screen.findByDisplayValue(
        "https://cache.example.com/management-api",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(/deployment configuration or administrator/),
    ).toBeDefined();
    expect(
      screen.getByText(/authentication proxy requires them/),
    ).toBeDefined();
    const apiKey = screen.getByLabelText("API key") as HTMLInputElement;
    expect(apiKey.type).toBe("password");
    expect(apiKey.value).toBe("");
  });
});
