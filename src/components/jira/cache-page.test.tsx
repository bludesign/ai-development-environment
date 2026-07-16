import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { JiraCachePage } from "./cache-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("JiraCachePage", () => {
  test("clears the cache only after alert-dialog confirmation", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query JiraCachePage")) {
        return {
          jiraSettings: {
            siteUrl: "https://example.atlassian.net",
            email: "user@example.com",
            tokenConfigured: true,
            cacheTtlSeconds: 300,
            updatedAt: new Date(0).toISOString(),
          },
          jiraCacheMetrics: { windows: [], operations: [] },
          jiraApiCalls: { items: [], total: 0, limit: 50, offset: 0 },
          jiraCachedTickets: { items: [], total: 0, limit: 50, offset: 0 },
        } as never;
      }
      if (query.includes("clearJiraCache"))
        return { clearJiraCache: true } as never;
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<JiraCachePage />);
    const clearButton = await screen.findByRole("button", {
      name: "Clear cache",
    });
    fireEvent.click(clearButton);
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      requestMock.mock.calls.some(([query]) =>
        String(query).includes("clearJiraCache"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(clearButton);
    fireEvent.click(await screen.findByRole("button", { name: "Clear cache" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("mutation { clearJiraCache }"),
    );
  });
});
