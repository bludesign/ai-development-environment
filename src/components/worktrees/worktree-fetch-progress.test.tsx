import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type {
  WorktreeFetchBatch,
  WorktreeFetchRow,
} from "./use-worktree-fetch";
import { WorktreeFetchProgress } from "./worktree-fetch-progress";

afterEach(cleanup);

function row(
  codebaseId: string,
  status: WorktreeFetchRow["status"],
  changes: Partial<WorktreeFetchRow> = {},
): WorktreeFetchRow {
  return {
    codebaseId,
    repositoryName: `Repository ${codebaseId}`,
    agentName: "Studio",
    folder: `/repos/${codebaseId}`,
    status,
    jobId: null,
    error: null,
    skipReason: null,
    worktreeRefreshError: null,
    worktreesRefreshedAt: null,
    ...changes,
  };
}

function batch(
  rows: WorktreeFetchRow[],
  changes: Partial<WorktreeFetchBatch> = {},
): WorktreeFetchBatch {
  return {
    id: "batch-1",
    rows,
    phase: "fetching",
    monitoringError: null,
    monitoringMissingJobs: 0,
    pageUpdateError: null,
    legacyRefreshRequested: false,
    legacyRefreshError: null,
    ...changes,
  };
}

test("shows actual settled checkout progress and readable repository outcomes", () => {
  render(
    <WorktreeFetchProgress
      batch={batch([
        row("a", "SUCCEEDED", {
          jobId: "job-a",
          worktreesRefreshedAt: "2026-09-22T12:00:00Z",
        }),
        row("b", "RUNNING", { jobId: "job-b" }),
        row("c", "SKIPPED", { skipReason: "OFFLINE" }),
        row("d", "FAILED", { error: "Remote authentication failed" }),
        row("e", "CANCELLING"),
      ])}
      onDismiss={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "3 of 5 checkouts processed",
  );
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("3");
  expect(
    screen.queryByRole("button", { name: "Dismiss fetch results" }),
  ).toBeNull();
  fireEvent.click(screen.getByText("Repository details"));
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(5);
  expect(rows[0]!.textContent).toContain("Repository a · Studio");
  expect(rows[0]!.textContent).toContain("/repos/a");
  expect(
    within(rows[0]!)
      .getByRole("link", { name: "View job logs" })
      .getAttribute("href"),
  ).toBe("/jobs/job-a");
  expect(within(rows[2]!).getByText("The agent is offline.")).toBeDefined();
  expect(
    within(rows[3]!).getByText("Remote authentication failed"),
  ).toBeDefined();
  expect(within(rows[4]!).getByText("Cancelling")).toBeDefined();
});

test("retains refresh warnings after a completed fetch without claiming freshness", () => {
  render(
    <WorktreeFetchProgress
      batch={batch(
        [
          row("a", "SUCCEEDED", {
            worktreeRefreshError: "Inventory unavailable",
          }),
          row("b", "SUCCEEDED"),
        ],
        { phase: "finished", legacyRefreshRequested: true },
      )}
      onDismiss={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(screen.queryByText("Page updated.")).toBeNull();
  expect(
    screen.getByText("Worktree status could not be refreshed."),
  ).toBeDefined();
  expect(
    screen.getByText(/This agent has not confirmed updated worktree status/),
  ).toBeDefined();
});

test("offers an explicit page retry and preserves the batch summary", () => {
  const retry = vi.fn();
  const dismiss = vi.fn();
  render(
    <WorktreeFetchProgress
      batch={batch(
        [
          row("a", "SUCCEEDED", {
            worktreesRefreshedAt: "2026-09-22T12:00:00Z",
          }),
        ],
        { phase: "refreshFailed", pageUpdateError: "Request failed" },
      )}
      onDismiss={dismiss}
      onRetry={retry}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "1 fetched · 0 failed · 0 skipped",
  );
  expect(screen.queryByText("Page updated.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry page update" }));
  expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss fetch results" }),
  );
  expect(dismiss).toHaveBeenCalledOnce();
});
