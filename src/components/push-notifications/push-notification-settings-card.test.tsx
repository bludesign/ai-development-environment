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

import { PushNotificationSettingsCard } from "./push-notification-settings-card";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

type Settings = {
  pushNotificationSettings: Record<string, unknown>;
};

function settings(overrides: Record<string, unknown> = {}): Settings {
  return {
    pushNotificationSettings: {
      tokenConfigured: false,
      tokenTeamId: null,
      tokenKeyId: null,
      tokenPrivateKeyFingerprint: null,
      tokenConfiguredAt: null,
      tokenLastUsedAt: null,
      tokenLastError: null,
      certificates: [],
      ...overrides,
    },
  };
}

function dropFile(zoneName: string, file: File) {
  fireEvent.drop(screen.getByRole("group", { name: zoneName }), {
    dataTransfer: { files: { item: () => file, length: 1, 0: file } },
  });
}

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

  test("accepts a dropped .p8, saves it, and clears the browser value", async () => {
    const configured = settings({
      tokenConfigured: true,
      tokenTeamId: "TEAM123",
      tokenKeyId: "KEY123",
      tokenPrivateKeyFingerprint: "KEY-FINGERPRINT",
      tokenConfiguredAt: "2026-07-20T01:00:00.000Z",
    });
    request.mockImplementation(async (operation) => {
      if (operation.includes("query PushSettings")) return settings() as never;
      if (operation.includes("SaveApnsToken")) {
        return {
          saveApnsTokenSettings: configured.pushNotificationSettings,
        } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });

    render(<PushNotificationSettingsCard />);
    const teamId = await screen.findByLabelText("Team ID");
    const privateKey = screen.getByLabelText(
      "APNs .p8 private key",
    ) as HTMLTextAreaElement;
    fireEvent.change(teamId, { target: { value: "TEAM123" } });
    fireEvent.change(screen.getByLabelText("Key ID"), {
      target: { value: "KEY123" },
    });

    const pem =
      "-----BEGIN PRIVATE KEY-----\ntest-key\n-----END PRIVATE KEY-----";
    const file = new File([pem], "AuthKey_KEY123.p8", {
      type: "application/pkcs8",
    });
    Object.defineProperty(file, "text", { value: async () => pem });
    dropFile("APNs private key drop zone", file);

    await waitFor(() => expect(privateKey.value).toBe(pem));
    expect(
      screen.getByText("Loaded AuthKey_KEY123.p8. Save to use this key."),
    ).toBeDefined();

    const form = teamId.closest("form") as HTMLFormElement;
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("SaveApnsToken"),
        { input: { teamId: "TEAM123", keyId: "KEY123", privateKey: pem } },
      ),
    );
    expect(privateKey.value).toBe("");
    expect(screen.getByText(/KEY-FINGERPRINT/)).toBeDefined();
  });

  test("accepts a dropped .p12 and rejects files of the wrong type", async () => {
    request.mockResolvedValue(settings() as never);
    render(<PushNotificationSettingsCard />);
    await screen.findByLabelText("Team ID");

    const bundle = screen.getByLabelText(
      "APNs .p12 certificate bundle",
    ) as HTMLTextAreaElement;
    dropFile(
      "APNs certificate drop zone",
      new File(["certificate-bytes"], "push.p12", {
        type: "application/x-pkcs12",
      }),
    );
    expect(
      await screen.findByText(
        "Loaded push.p12. Add the certificate to store it.",
      ),
    ).toBeDefined();
    expect(screen.getByText("push.p12 ready to save.")).toBeDefined();
    // The dropped file is encoded into the textarea so it can also be pasted.
    expect(bundle.value).toBe(btoa("certificate-bytes"));

    dropFile(
      "APNs private key drop zone",
      new File(["text"], "notes.txt", { type: "text/plain" }),
    );
    expect(
      await screen.findByText(
        "Choose a valid .p8 file containing a PKCS#8 private key.",
      ),
    ).toBeDefined();

    dropFile(
      "APNs certificate drop zone",
      new File(["text"], "notes.txt", { type: "text/plain" }),
    );
    expect(
      await screen.findByText(
        "Choose a valid .p12 or .pfx certificate bundle.",
      ),
    ).toBeDefined();
  });
});
