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
});
