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

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});

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
          githubCacheMetrics: {
            windows: [
              {
                window: "5m",
                total: 1,
                live: 1,
                cache: 0,
                errors: 0,
                averageMs: 20,
                pointsUsed: 7,
                pointsAvoided: 0,
              },
            ],
            apiTypes: [
              {
                apiType: "GRAPHQL",
                windows: [
                  {
                    window: "5m",
                    total: 18,
                    live: 7,
                    cache: 11,
                    errors: 0,
                    averageMs: 220,
                    pointsUsed: 3,
                    pointsAvoided: 11,
                  },
                  {
                    window: "10m",
                    total: 139,
                    live: 24,
                    cache: 115,
                    errors: 0,
                    averageMs: 63,
                    pointsUsed: 4,
                    pointsAvoided: 115,
                  },
                  {
                    window: "1h",
                    total: 139,
                    live: 24,
                    cache: 115,
                    errors: 0,
                    averageMs: 63,
                    pointsUsed: 4,
                    pointsAvoided: 115,
                  },
                  {
                    window: "24h",
                    total: 139,
                    live: 24,
                    cache: 115,
                    errors: 0,
                    averageMs: 63,
                    pointsUsed: 4,
                    pointsAvoided: 115,
                  },
                ],
              },
              {
                apiType: "REST",
                windows: [
                  {
                    window: "5m",
                    total: 4,
                    live: 4,
                    cache: 0,
                    errors: 0,
                    averageMs: 90,
                    pointsUsed: 0,
                    pointsAvoided: 0,
                  },
                  {
                    window: "10m",
                    total: 12,
                    live: 12,
                    cache: 0,
                    errors: 0,
                    averageMs: 82,
                    pointsUsed: 0,
                    pointsAvoided: 0,
                  },
                  {
                    window: "1h",
                    total: 48,
                    live: 48,
                    cache: 0,
                    errors: 0,
                    averageMs: 75,
                    pointsUsed: 0,
                    pointsAvoided: 0,
                  },
                  {
                    window: "24h",
                    total: 60,
                    live: 60,
                    cache: 0,
                    errors: 0,
                    averageMs: 73,
                    pointsUsed: 0,
                    pointsAvoided: 0,
                  },
                ],
              },
            ],
            operations: [
              {
                operation: "Viewer",
                windows: [
                  {
                    window: "5m",
                    total: 1,
                    live: 1,
                    cache: 0,
                    errors: 0,
                    averageMs: 20,
                    pointsUsed: 7,
                    pointsAvoided: 0,
                  },
                ],
              },
            ],
            requestSources: [
              {
                requestSource: "PULL_REQUEST_DETAILS",
                windows: [
                  {
                    window: "5m",
                    total: 1,
                    live: 1,
                    cache: 0,
                    errors: 0,
                    averageMs: 20,
                    pointsUsed: 7,
                    pointsAvoided: 0,
                  },
                ],
              },
            ],
          },
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
      if (query.includes("clearGitHubApiCalls")) {
        return { clearGitHubApiCalls: true } as never;
      }
      throw new Error(`Unexpected query: ${query}`);
    });

    const { container } = render(<GitHubCachePage />);
    expect(await screen.findByText("PAT · graphql")).toBeDefined();
    expect(screen.getByText("APP · core")).toBeDefined();
    const graphqlRateGrid = screen
      .getByText("PAT · graphql")
      .closest('[data-slot="card"]')?.parentElement;
    const restRateGrid = screen
      .getByText("APP · core")
      .closest('[data-slot="card"]')?.parentElement;
    expect(graphqlRateGrid?.className).not.toContain("sm:grid-cols-2");
    expect(restRateGrid?.className).not.toContain("sm:grid-cols-2");
    expect(screen.getByText("4993 / 5000")).toBeDefined();
    expect(screen.getByText("Status").closest("th")?.className).toContain(
      "min-w-56",
    );
    expect(screen.getByText("Calls by source")).toBeDefined();
    expect(screen.getAllByText(/L 1 · C 0 · E 0 · P 7\/0/)).toHaveLength(2);
    expect(screen.getByText("3 points used · 11 avoided")).toBeDefined();
    const graphqlRatePanel = screen
      .getByText("GraphQL rate limits")
      .closest('[data-slot="card"]');
    const restRatePanel = screen
      .getByText("REST rate limits")
      .closest('[data-slot="card"]');
    const graphqlMetrics = graphqlRatePanel?.querySelector(".border-t");
    const restMetrics = restRatePanel?.querySelector(".border-t");
    expect(graphqlMetrics?.className).toContain("grid-cols-2");
    expect(graphqlMetrics?.children).toHaveLength(4);
    expect(graphqlMetrics?.textContent).toContain("18");
    expect(restMetrics?.className).toContain("grid-cols-2");
    expect(restMetrics?.children).toHaveLength(4);
    expect(restMetrics?.textContent).toContain("60");
    expect(screen.getAllByText("Source")).toHaveLength(2);
    expect(screen.getAllByText("Pull request details")).toHaveLength(2);
    expect(
      screen.getByRole("combobox", { name: "Filter calls by API type" })
        .textContent,
    ).toContain("GraphQL & REST");
    expect(
      screen.getByRole("combobox", { name: "Filter calls by source" })
        .textContent,
    ).toContain("All sources");
    expect(
      screen.getByRole("combobox", { name: "Filter calls by live or cache" })
        .textContent,
    ).toContain("Live & cache");

    const apiTypeFilter = screen.getByRole("combobox", {
      name: "Filter calls by API type",
    });
    apiTypeFilter.focus();
    fireEvent.keyDown(apiTypeFilter, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "REST" }));

    const requestSourceFilter = screen.getByRole("combobox", {
      name: "Filter calls by source",
    });
    requestSourceFilter.focus();
    fireEvent.keyDown(requestSourceFilter, { key: "ArrowDown" });
    fireEvent.click(
      await screen.findByRole("option", { name: "Actions page" }),
    );

    const callSourceFilter = screen.getByRole("combobox", {
      name: "Filter calls by live or cache",
    });
    callSourceFilter.focus();
    fireEvent.keyDown(callSourceFilter, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Cache" }));
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("query GitHubCachePage") &&
            variables?.apiType === "REST" &&
            variables?.requestSource === "ACTIONS_PAGE" &&
            variables?.callSource === "CACHE" &&
            variables?.callOffset === 0,
        ),
      ).toBe(true),
    );
    const pointRateCell = screen.getByText("Live").closest("td");
    expect(pointRateCell?.firstElementChild?.textContent).toBe("Live");
    expect(pointRateCell?.textContent).toContain("0 avoided");
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
    expect(container.querySelector('td[colspan="6"]')).not.toBeNull();
    const callRow = screen.getByText("pullRequestId=PR_kwDO123").closest("tr");
    const callOperation = callRow?.querySelector("td:nth-child(2) > p");
    expect(callOperation?.textContent).toBe("Viewer");
    expect(callOperation?.previousElementSibling?.textContent).toContain(
      "GRAPHQLPAT",
    );
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

    fireEvent.click(screen.getByRole("button", { name: "Clear recent calls" }));
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      requestMock.mock.calls.some(([query]) =>
        String(query).includes("clearGitHubApiCalls"),
      ),
    ).toBe(false);
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear recent calls" }),
    );
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        "mutation { clearGitHubApiCalls }",
      ),
    );
  });
});
