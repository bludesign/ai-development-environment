import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { GitHubCachePage } from "./cache-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("GitHubCachePage", () => {
  test("shows GraphQL and REST buckets, point costs, and confirms cache clearing", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query GitHubCachePage")) {
        return {
          githubSettings: {
            tokenConfigured: true,
            defaultJiraKeyRegex: "",
            actionsNotificationPollIntervalSeconds: 60,
            cacheTtlSeconds: 300,
            updatedAt: new Date(0).toISOString(),
          },
          githubRateLimitSnapshots: [
            {
              authentication: "PAT",
              resource: "graphql",
              limit: 5000,
              remaining: 4993,
              used: 7,
              resetAt: "2026-07-26T06:00:00.000Z",
              observedAt: "2026-07-26T05:00:00.000Z",
            },
            {
              authentication: "APP",
              resource: "core",
              limit: 15000,
              remaining: 14990,
              used: 10,
              resetAt: "2026-07-26T06:00:00.000Z",
              observedAt: "2026-07-26T05:00:00.000Z",
            },
          ],
          githubCacheMetrics: { windows: [], operations: [] },
          githubApiCalls: {
            items: [
              {
                id: "call-1",
                authentication: "PAT",
                apiType: "GRAPHQL",
                method: "POST",
                endpoint: "https://api.github.com/graphql",
                operation: "Viewer",
                requestSource: "PULL_REQUEST_DETAILS",
                requestSummary: "pullRequestId=PR_kwDO123 · cursor=null",
                variables: { pullRequestId: "PR_kwDO123", cursor: null },
                source: "LIVE",
                durationMs: 20,
                statusCode: 200,
                error: null,
                servedStale: false,
                pointCost: 7,
                pointsAvoided: 0,
                rateLimitLimit: 5000,
                rateLimitRemaining: 4993,
                rateLimitUsed: 7,
                rateLimitResetAt: "2026-07-26T06:00:00.000Z",
                rateLimitResource: "graphql",
                createdAt: "2026-07-26T05:00:00.000Z",
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          },
          githubCachedEntries: { items: [], total: 0, limit: 50, offset: 0 },
        } as never;
      }
      if (query.includes("clearGitHubCache")) {
        return { clearGitHubCache: true } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    const { container } = render(<GitHubCachePage />);
    expect(await screen.findByText("PAT · graphql")).toBeDefined();
    expect(screen.getByText("APP · core")).toBeDefined();
    expect(screen.getByText("4993 / 5000")).toBeDefined();
    expect(screen.getByText("Points and rate")).toBeDefined();
    expect(screen.getByText("Source")).toBeDefined();
    expect(screen.getByText("Status")).toBeDefined();
    expect(screen.getByText("Pull request details")).toBeDefined();
    expect(screen.getByText("Live")).toBeDefined();
    expect(screen.getByText("pullRequestId=PR_kwDO123")).toBeDefined();
    expect(screen.queryByText(/cursor=null/)).toBeNull();
    expect(screen.getAllByText(/PR_kwDO123/)).toHaveLength(1);
    expect(
      document.querySelector('[data-slot="hover-card-content"]'),
    ).toBeNull();
    fireEvent.pointerEnter(screen.getByText("pullRequestId=PR_kwDO123"), {
      pointerType: "mouse",
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="hover-card-content"] pre')
          ?.textContent,
      ).toContain('"cursor": null'),
    );
    expect(container.querySelector('td[colspan="7"]')).not.toBeNull();
    const callRow = screen.getByText("pullRequestId=PR_kwDO123").closest("tr");
    const callTime = callRow?.querySelector(
      'time[datetime="2026-07-26T05:00:00.000Z"]',
    );
    expect(callTime?.textContent).not.toContain("2026");

    fireEvent.click(screen.getByRole("button", { name: "Clear cache" }));
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      requestMock.mock.calls.some(([query]) =>
        String(query).includes("clearGitHubCache"),
      ),
    ).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Clear cache" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("mutation { clearGitHubCache }"),
    );
  });
});
