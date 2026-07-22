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

import { SettingsPage } from "./settings-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("SettingsPage", () => {
  test("keeps the stored GitHub token write-only and submits a replacement", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("jiraSettings")) {
        return {
          jiraSettings: {
            siteUrl: "https://example.atlassian.net",
            email: "user@example.com",
            tokenConfigured: true,
            cacheTtlSeconds: 300,
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      if (query.includes("githubSettings")) {
        return {
          githubSettings: {
            tokenConfigured: true,
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      if (query.includes("SaveGitHubSettings")) {
        return {
          saveGitHubSettings: {
            tokenConfigured: true,
            updatedAt: new Date().toISOString(),
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<SettingsPage />);

    const tokenInput = (await screen.findByLabelText(
      "GitHub personal access token",
    )) as HTMLInputElement;
    expect(screen.getByRole("region", { name: "Development" })).toBeDefined();
    expect(
      screen.getByRole("region", { name: "Apple services" }),
    ).toBeDefined();
    expect(screen.getByRole("region", { name: "Integrations" })).toBeDefined();
    expect(tokenInput.type).toBe("password");
    expect(tokenInput.value).toBe("");
    const createTokenLink = screen.getByRole("link", {
      name: /Create fine-grained token/,
    });
    expect(createTokenLink.getAttribute("href")).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(createTokenLink.getAttribute("target")).toBe("_blank");
    expect(createTokenLink.getAttribute("rel")).toBe("noreferrer");
    expect(
      await screen.findByRole("link", { name: /Download Visual Studio Code/ }),
    ).toHaveProperty("href", "https://code.visualstudio.com/download");
    expect(
      screen.getByRole("link", { name: /Download VS Code Insiders/ }),
    ).toHaveProperty("href", "https://code.visualstudio.com/insiders/");

    fireEvent.change(tokenInput, { target: { value: "replacement-token" } });
    const form = tokenInput.closest("form");
    expect(form).not.toBeNull();
    fireEvent.click(
      within(form as HTMLFormElement).getByRole("button", {
        name: "Save settings",
      }),
    );

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveGitHubSettings"),
        { input: { apiToken: "replacement-token" } },
      ),
    );
    expect(screen.queryByDisplayValue("replacement-token")).toBeNull();
  });

  test("guides setup and keeps the GitHub App private key write-only", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("jiraSettings")) {
        return {
          jiraSettings: {
            siteUrl: null,
            email: null,
            tokenConfigured: false,
            cacheTtlSeconds: 300,
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      if (query.includes("query GitHubSettings")) {
        return {
          githubSettings: {
            tokenConfigured: true,
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      if (query.includes("query GitHubAppSettings")) {
        return {
          githubAppSettings: {
            configured: false,
            appId: null,
            installationId: null,
            privateKeyConfigured: false,
            keyFingerprint: null,
            appSlug: null,
            accountLogin: null,
            repositorySelection: null,
            actionsPermission: null,
            verifiedAt: null,
            updatedAt: null,
          },
        } as never;
      }
      if (query.includes("SaveGitHubAppSettings")) {
        return {
          saveGitHubAppSettings: {
            configured: true,
            appId: "123",
            installationId: "456",
            privateKeyConfigured: true,
            keyFingerprint: "SHA256:fingerprint",
            appSlug: "workflow-rerunner",
            accountLogin: "acme",
            repositorySelection: "selected",
            actionsPermission: "write",
            verifiedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<SettingsPage />);

    const appId = await screen.findByLabelText("GitHub App ID");
    const installationId = screen.getByLabelText("Installation ID");
    const privateKey = screen.getByLabelText(
      "PEM private key",
    ) as HTMLTextAreaElement;
    const appLink = screen.getByRole("link", { name: /New GitHub App/ });
    expect(appLink.getAttribute("href")).toBe(
      "https://github.com/settings/apps/new",
    );
    expect(appLink.getAttribute("target")).toBe("_blank");
    expect(appLink.getAttribute("rel")).toBe("noreferrer");
    expect(screen.getByText(/Actions to Read and write/)).toBeDefined();
    expect(
      screen.getByText(
        "https://github.com/organizations/<Organization-name>/settings/installations/<ID>",
      ),
    ).toBeDefined();

    fireEvent.change(appId, { target: { value: "123" } });
    fireEvent.change(installationId, { target: { value: "456" } });
    const dropZone = screen.getByRole("group", {
      name: "PEM private key drop zone",
    });
    const invalidFile = new File(["not a key"], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(invalidFile, "text", {
      value: async () => "not a key",
    });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: { item: () => invalidFile, length: 1, 0: invalidFile },
      },
    });
    expect(
      await screen.findByText(
        "Drop a valid .pem file containing an RSA private key.",
      ),
    ).toBeDefined();

    const pem =
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
    const pemFile = new File([pem], "workflow-rerunner.pem", {
      type: "application/x-pem-file",
    });
    Object.defineProperty(pemFile, "text", { value: async () => pem });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: { item: () => pemFile, length: 1, 0: pemFile },
      },
    });
    await waitFor(() => expect(privateKey.value).toBe(pem));
    expect(
      screen.getByText(
        "Loaded workflow-rerunner.pem. Save and verify to use this key.",
      ),
    ).toBeDefined();
    const form = appId.closest("form");
    fireEvent.click(
      within(form as HTMLFormElement).getByRole("button", {
        name: "Save and verify",
      }),
    );

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveGitHubAppSettings"),
        {
          input: {
            appId: "123",
            installationId: "456",
            privateKey: pem,
          },
        },
      ),
    );
    expect(privateKey.value).toBe("");
    expect(screen.queryByDisplayValue(/BEGIN PRIVATE KEY/)).toBeNull();
    expect(
      screen.getByText("Connected to workflow-rerunner on acme"),
    ).toBeDefined();
  });
});
