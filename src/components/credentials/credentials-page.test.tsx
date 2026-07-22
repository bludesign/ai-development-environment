import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: request,
}));

import { CredentialsPage } from "./credentials-page";

describe("CredentialsPage", () => {
  beforeEach(() => {
    request.mockReset();
  });

  test("renders configuration and metadata without secret actions or values", async () => {
    request.mockResolvedValue({
      credentialStoreStatus: {
        storageType: "DATABASE",
        state: "WARNING",
        encryptionState: "PLAINTEXT",
        details: [
          { label: "Location", value: "Application database" },
          { label: "Encryption key", value: "Not configured" },
        ],
        itemCount: 1,
        mismatchCount: 0,
        warnings: [
          {
            code: "DATABASE_UNENCRYPTED",
            message: "server fallback message",
          },
        ],
      },
      credentials: [
        {
          id: "jira/default/api-token",
          kind: "jira-api-token",
          ownerId: "default",
          ownerFeature: "Jira",
          storageType: "DATABASE",
          protection: "PLAINTEXT",
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      ],
    });
    render(<CredentialsPage />);

    expect(await screen.findByText("Credential storage")).toBeTruthy();
    expect(
      await screen.findByText("Database credentials are not encrypted"),
    ).toBeTruthy();
    expect(screen.getByText("openssl rand -base64 32")).toBeTruthy();
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
});
