import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { IosDeviceSettingsCard } from "./settings-card";
import type { IosDeviceSettings } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

function settings(
  overrides: Partial<IosDeviceSettings> = {},
): IosDeviceSettings {
  return {
    organizationName: "AI Development Environment",
    profileIdentifier: "com.example.device-enrollment",
    signerConfigured: true,
    signerFingerprint: "SIGNER-FINGERPRINT",
    signerCreatedAt: "2026-07-20T00:00:00.000Z",
    signerExpiresAt: "2036-07-20T00:00:00.000Z",
    appStoreConnectConfigured: false,
    appStoreConnectIssuerId: null,
    appStoreConnectKeyId: null,
    appStoreConnectPrivateKeyConfigured: false,
    appStoreConnectPrivateKeyFingerprint: null,
    appStoreConnectVerifiedAt: null,
    appStoreConnectLastTestedAt: null,
    appStoreConnectVerificationError: null,
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("IosDeviceSettingsCard", () => {
  test("keeps profile and App Store Connect acquisition guidance visible for configured credentials", async () => {
    request.mockResolvedValue({
      iosDeviceSettings: settings({
        appStoreConnectConfigured: true,
        appStoreConnectIssuerId: "issuer-1",
        appStoreConnectKeyId: "key-1",
        appStoreConnectPrivateKeyConfigured: true,
      }),
    } as never);

    render(<IosDeviceSettingsCard />);

    expect(await screen.findByDisplayValue("issuer-1")).toBeDefined();
    expect(
      screen.getByText(
        /iOS displays this organization while the enrollment profile is installed/,
      ),
    ).toBeDefined();
    expect(screen.getByText(/stable reverse-DNS identifier/)).toBeDefined();
    const apiKeysLink = screen.getByRole("link", {
      name: /Open App Store Connect API keys/,
    });
    expect(apiKeysLink.getAttribute("href")).toBe(
      "https://appstoreconnect.apple.com/access/integrations/api",
    );
    expect(apiKeysLink.getAttribute("target")).toBe("_blank");
  });

  test("accepts a dropped .p8, saves and verifies it, and clears the browser value", async () => {
    const initial = settings();
    const configured = settings({
      appStoreConnectConfigured: true,
      appStoreConnectIssuerId: "issuer-1",
      appStoreConnectKeyId: "key-1",
      appStoreConnectPrivateKeyConfigured: true,
      appStoreConnectPrivateKeyFingerprint: "KEY-FINGERPRINT",
      appStoreConnectVerifiedAt: "2026-07-20T01:00:00.000Z",
      appStoreConnectLastTestedAt: "2026-07-20T01:00:00.000Z",
    });
    request.mockImplementation(async (operation) => {
      if (operation.includes("query IosDeviceSettings")) {
        return { iosDeviceSettings: initial } as never;
      }
      if (operation.includes("SaveAppStoreConnectSettings")) {
        return { saveAppStoreConnectSettings: configured } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    render(<IosDeviceSettingsCard />);
    const issuer = await screen.findByLabelText("Issuer ID");
    const keyId = screen.getByLabelText("Key ID");
    const privateKey = screen.getByLabelText(
      "App Store Connect .p8 private key",
    ) as HTMLTextAreaElement;
    fireEvent.change(issuer, { target: { value: "issuer-1" } });
    fireEvent.change(keyId, { target: { value: "key-1" } });

    const pem =
      "-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----";
    const file = new File([pem], "AuthKey_KEY1.p8", {
      type: "application/pkcs8",
    });
    Object.defineProperty(file, "text", { value: async () => pem });
    fireEvent.drop(
      screen.getByRole("group", {
        name: "App Store Connect private key drop zone",
      }),
      {
        dataTransfer: {
          files: { item: () => file, length: 1, 0: file },
        },
      },
    );
    await waitFor(() => expect(privateKey.value).toBe(pem));
    expect(
      screen.getByText(
        "Loaded AuthKey_KEY1.p8. Save and verify to use this key.",
      ),
    ).toBeDefined();

    const form = issuer.closest("form");
    fireEvent.click(
      within(form as HTMLFormElement).getByRole("button", {
        name: "Save and verify",
      }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("SaveAppStoreConnectSettings"),
        {
          input: {
            issuerId: "issuer-1",
            keyId: "key-1",
            privateKey: pem,
          },
        },
      ),
    );
    expect(privateKey.value).toBe("");
    expect(screen.queryByDisplayValue(/BEGIN PRIVATE KEY/)).toBeNull();
    expect(screen.getByText("KEY-FINGERPRINT")).toBeDefined();
  });

  test("supports pasted keys, rejects the wrong file type, and keeps retest disabled without a stored key", async () => {
    request.mockResolvedValue({ iosDeviceSettings: settings() } as never);
    render(<IosDeviceSettingsCard />);

    const privateKey = (await screen.findByLabelText(
      "App Store Connect .p8 private key",
    )) as HTMLTextAreaElement;
    fireEvent.change(privateKey, {
      target: {
        value: "-----BEGIN PRIVATE KEY-----\npasted\n-----END PRIVATE KEY-----",
      },
    });
    expect(privateKey.value).toContain("pasted");

    const invalid = new File(["text"], "notes.txt", { type: "text/plain" });
    fireEvent.drop(
      screen.getByRole("group", {
        name: "App Store Connect private key drop zone",
      }),
      {
        dataTransfer: {
          files: { item: () => invalid, length: 1, 0: invalid },
        },
      },
    );
    expect(
      await screen.findByText(
        "Choose a valid .p8 file containing a PKCS#8 private key.",
      ),
    ).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Retest" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
