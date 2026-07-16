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
    expect(tokenInput.type).toBe("password");
    expect(tokenInput.value).toBe("");

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
});
