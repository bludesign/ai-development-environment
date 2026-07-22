import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { PushNotificationSettingsCard } from "./push-notification-settings-card";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("PushNotificationSettingsCard", () => {
  test("links to Apple sources and explains token and certificate preparation", async () => {
    request.mockResolvedValue({
      pushNotificationSettings: {
        tokenConfigured: true,
        tokenTeamId: "TEAM123",
        tokenKeyId: "KEY123",
        tokenPrivateKeyFingerprint: "fingerprint",
        tokenConfiguredAt: new Date(0).toISOString(),
        tokenLastUsedAt: null,
        tokenLastError: null,
        certificates: [],
      },
    } as never);

    render(<PushNotificationSettingsCard />);

    expect(await screen.findByDisplayValue("TEAM123")).toBeDefined();
    const tokenKeyLink = screen.getByRole("link", {
      name: /Create an APNs key/,
    });
    expect(tokenKeyLink.getAttribute("href")).toBe(
      "https://developer.apple.com/account/resources/authkeys/add",
    );
    expect(tokenKeyLink.getAttribute("target")).toBe("_blank");
    expect(
      screen
        .getByRole("link", { name: /Open membership details/ })
        .getAttribute("href"),
    ).toBe("https://developer.apple.com/account#MembershipDetailsCard");
    expect(
      screen
        .getByRole("link", { name: /Create an APNs certificate/ })
        .getAttribute("href"),
    ).toBe("https://developer.apple.com/account/resources/certificates/add");
    expect(
      screen.getByText(/export both as a password-protected .p12/),
    ).toBeDefined();
  });
});
