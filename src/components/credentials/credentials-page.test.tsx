import { cleanup, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: request,
}));

import { CredentialsPage } from "./credentials-page";

describe("CredentialsPage", () => {
  beforeEach(() => {
    cleanup();
    request.mockReset();
  });

  test("renders configuration and metadata without secret actions or values", async () => {
    request.mockResolvedValue({
      credentialStoreStatus: {
        storageType: "DATABASE",
        state: "READY",
        encryptionState: "ENCRYPTED",
        details: [
          { label: "Location", value: "Application database" },
          { label: "Encryption key", value: "Derived from APP_SECRET" },
        ],
        itemCount: 1,
        mismatchCount: 0,
        warnings: [],
      },
      credentials: [
        {
          id: "jira/default/api-token",
          kind: "jira-api-token",
          ownerId: "default",
          ownerFeature: "Jira",
          storageType: "DATABASE",
          protection: "ENCRYPTED",
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
    });
    render(<CredentialsPage />);

    expect(await screen.findByText("Credential storage")).toBeTruthy();
    expect(screen.getByText("Derived from APP_SECRET")).toBeTruthy();
    expect(screen.getByText("API token")).toBeTruthy();
    expect(screen.queryByText("jira-secret-value")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /reveal|copy|delete|edit/i }),
    ).toBeNull();
  });

  test("renders external-backend errors without losing the page", async () => {
    request.mockResolvedValue({
      credentialStoreStatus: {
        storageType: "KEYCHAIN",
        state: "ERROR",
        encryptionState: "ERROR",
        details: [{ label: "Host platform", value: "linux" }],
        itemCount: 0,
        mismatchCount: 0,
        warnings: [
          {
            code: "KEYCHAIN_UNSUPPORTED_PLATFORM",
            message: "server fallback message",
          },
        ],
      },
      credentials: [],
    });
    render(<CredentialsPage />);
    expect(
      await screen.findByText("Keychain is unsupported on this host"),
    ).toBeTruthy();
    expect(screen.getByText("No credentials stored")).toBeTruthy();
  });

  test("marks a read-only Vault and reports adopted credentials", async () => {
    request.mockResolvedValue({
      credentialStoreStatus: {
        storageType: "VAULT",
        state: "READY",
        encryptionState: "EXTERNAL",
        details: [
          { label: "Address", value: "https://vault.test/" },
          { label: "Vault access", value: "Read-only" },
        ],
        itemCount: 2,
        mismatchCount: 0,
        readOnly: true,
        adoptedCount: 2,
        warnings: [],
      },
      credentials: [],
    });
    render(<CredentialsPage />);

    // The badge and the Vault access detail both read "Read-only".
    expect(await screen.findAllByText("Read-only")).toHaveLength(2);
    expect(screen.getByText("Vault access")).toBeTruthy();
    expect(
      screen.getByText(
        "2 credential(s) were adopted from the external backend when the server started.",
      ),
    ).toBeTruthy();
  });

  test("explains an empty inventory in terms of the configured Vault path", async () => {
    request.mockResolvedValue({
      credentialStoreStatus: {
        storageType: "VAULT",
        state: "READY",
        encryptionState: "EXTERNAL",
        details: [],
        itemCount: 0,
        mismatchCount: 0,
        readOnly: false,
        adoptedCount: 0,
        warnings: [],
      },
      credentials: [],
    });
    render(<CredentialsPage />);

    expect(
      await screen.findByText(/No credentials were found under the configured/),
    ).toBeTruthy();
    expect(screen.queryByText("Read-only")).toBeNull();
    expect(
      within(document.body).queryByText(/were adopted from the external/),
    ).toBeNull();
  });
});
