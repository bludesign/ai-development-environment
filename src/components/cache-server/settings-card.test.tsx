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

  test("keeps visible values but disables credential changes for a read-only store", async () => {
    request.mockImplementation(async (operation) => {
      if (operation.includes("CredentialStoreWritability")) {
        return { credentialStoreStatus: { readOnly: true } } as never;
      }
      return {
        cacheServerSettings: {
          configured: true,
          baseUrl: "https://cache.example.com/management-api",
          apiKeyConfigured: true,
          headers: [{ name: "X-Proxy-Token", valueConfigured: true }],
          updatedAt: new Date(0).toISOString(),
        },
      } as never;
    });

    render(<CacheServerSettingsCard />);

    const baseUrl = (await screen.findByDisplayValue(
      "https://cache.example.com/management-api",
    )) as HTMLInputElement;
    await screen.findByText(/read-only/);
    expect(baseUrl.disabled).toBe(true);
    expect(
      (screen.getByLabelText("API key") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Test" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
