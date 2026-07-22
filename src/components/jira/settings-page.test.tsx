import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { JiraSettingsPage } from "./settings-page";
import { controlPlaneRequest } from "@/lib/control-plane-client";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("JiraSettingsPage", () => {
  test("never renders the stored token and submits only a replacement", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query { jiraSettings")) {
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
      return {
        saveJiraSettings: {
          siteUrl: "https://example.atlassian.net",
          email: "user@example.com",
          tokenConfigured: true,
          cacheTtlSeconds: 300,
          updatedAt: new Date().toISOString(),
        },
      } as never;
    });

    render(<JiraSettingsPage />);

    expect(await screen.findByDisplayValue("user@example.com")).toBeDefined();
    const tokenInput = screen.getByLabelText(
      "Jira API token",
    ) as HTMLInputElement;
    expect(tokenInput.value).toBe("");
    expect(tokenInput.type).toBe("password");
    expect(
      screen.getByText(/copy only its https:\/\/\*\.atlassian\.net origin/),
    ).toBeDefined();
    const tokenLink = screen.getByRole("link", {
      name: /Create Jira API token/,
    });
    expect(tokenLink.getAttribute("href")).toBe(
      "https://id.atlassian.com/manage-profile/security/api-tokens",
    );
    expect(tokenLink.getAttribute("target")).toBe("_blank");

    fireEvent.change(tokenInput, { target: { value: "replacement-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveJiraSettings"),
        expect.objectContaining({
          input: expect.objectContaining({ apiToken: "replacement-token" }),
        }),
      );
    });
    expect(screen.queryByDisplayValue("replacement-token")).toBeNull();
  });

  test("requires confirmation before saving a changed Jira site", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query { jiraSettings")) {
        return {
          jiraSettings: {
            siteUrl: "https://old.atlassian.net",
            email: "user@example.com",
            tokenConfigured: true,
            cacheTtlSeconds: 300,
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      return {
        saveJiraSettings: {
          siteUrl: "https://new.atlassian.net",
          email: "user@example.com",
          tokenConfigured: true,
          cacheTtlSeconds: 300,
          updatedAt: new Date().toISOString(),
        },
      } as never;
    });

    render(<JiraSettingsPage />);
    const siteInput = (await screen.findByLabelText(
      "Jira Cloud site URL",
    )) as HTMLInputElement;
    fireEvent.change(siteInput, {
      target: { value: "https://new.atlassian.net" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      screen.getByText(
        "Changing the Jira site removes all saved Jira projects, sources, and cached data. Continue?",
      ),
    ).toBeDefined();
    expect(
      requestMock.mock.calls.some(([query]) =>
        String(query).includes("SaveJiraSettings"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveJiraSettings"),
        expect.objectContaining({
          input: expect.objectContaining({
            resetSite: true,
            siteUrl: "https://new.atlassian.net",
          }),
        }),
      ),
    );
  });
});
