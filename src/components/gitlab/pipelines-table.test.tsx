import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import type { GitLabJobView, GitLabPipelineView } from "@/services/gitlab";

import { GitLabPipelineJobs, GitLabPipelinesTable } from "./pipelines-table";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneRecovery: vi.fn(),
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const pipeline: GitLabPipelineView = {
  id: "94",
  projectId: "21",
  iid: "14",
  ref: "feature/api",
  branch: "feature/api",
  sha: "abcdef12",
  source: "merge_request_event",
  status: "RUNNING",
  webUrl: "https://gitlab.example/group/app/-/pipelines/94",
  mergeRequests: [],
  worktreeId: null,
  worktreeHighlightColor: null,
  startedAt: "2026-09-20T12:00:00.000Z",
  createdAt: "2026-09-20T12:00:00.000Z",
  updatedAt: "2026-09-20T12:00:10.000Z",
  finishedAt: null,
  duration: null,
  queuedDuration: null,
};
const job: GitLabJobView = {
  id: "1",
  pipelineId: "94",
  name: "Unit tests",
  stage: "test",
  status: "RUNNING",
  ref: "feature/api",
  webUrl: "https://gitlab.example/group/app/-/jobs/1",
  allowFailure: false,
  createdAt: pipeline.createdAt,
  startedAt: pipeline.startedAt,
  finishedAt: null,
  duration: null,
  queuedDuration: 3,
  retried: false,
};
let next:
  | ((value: {
      data: { gitlabPipelineStatusChanged: { projectId: string; id: string } };
    }) => void)
  | undefined;
let recover: (() => void) | undefined;

beforeEach(() => {
  request.mockReset();
  next = undefined;
  recover = undefined;
  vi.mocked(controlPlaneSubscriptions).mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      next = sink.next;
      return vi.fn();
    }),
  } as never);
  vi.mocked(onControlPlaneRecovery).mockImplementation((callback) => {
    recover = callback;
    return vi.fn();
  });
  request.mockResolvedValue({
    gitlabPipeline: pipeline,
    gitlabPipelineJobs: [job],
  } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const expand = () =>
  fireEvent.click(
    screen.getByRole("button", { name: "Show jobs for #14 · feature/api" }),
  );

describe("GitLab pipeline details", () => {
  test("does not display a creation time as a missing start time", () => {
    render(
      <GitLabPipelinesTable
        pipelines={[{ ...pipeline, status: "PENDING", startedAt: null }]}
      />,
    );
    const row = screen
      .getByRole("button", { name: "Show jobs for #14 · feature/api" })
      .closest("tr")!;
    const timing = within(row).getAllByRole("cell")[6];
    expect(timing.querySelector("time")).toBeNull();
    expect(timing.textContent).toBe("—Duration —");
  });

  test("loads detail lazily, hydrates timing, and uses stage groups with readable statuses", async () => {
    request.mockResolvedValue({
      gitlabPipeline: {
        ...pipeline,
        status: "SUCCESS",
        duration: 65,
        queuedDuration: 4,
        finishedAt: "2026-09-20T12:01:05.000Z",
      },
      gitlabPipelineJobs: [{ ...job, status: "SUCCESS", duration: 62 }],
    } as never);
    render(<GitLabPipelinesTable pipelines={[pipeline]} />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.getAllByText("Merge request").length).toBeGreaterThan(0);
    expand();
    expect(
      await screen.findByRole("heading", { name: "Stage · test" }),
    ).toBeDefined();
    expect(screen.getByText("Duration 1m 5s")).toBeDefined();
    expect(screen.getByText("Queued 4s")).toBeDefined();
    expect(screen.getAllByText("Success")).toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("gitlabPipeline(projectId:"),
      { projectId: "21", pipelineId: "94" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("keeps current jobs distinct from retry history and marks allowed failures", () => {
    render(
      <GitLabPipelineJobs
        busy={false}
        onRetry={vi.fn()}
        jobs={[
          { ...job, id: "2", status: "SUCCESS" },
          { ...job, name: "Old unit tests", retried: true, status: "FAILED" },
          {
            ...job,
            id: "3",
            name: "Lint",
            stage: "quality",
            status: "FAILED",
            allowFailure: true,
          },
        ]}
      />,
    );
    expect(screen.getByText("2 jobs")).toBeDefined();
    expect(screen.getByText("Allowed to fail")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Old unit tests" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show retry history" }));
    expect(
      screen.getByRole("heading", { name: "Retry history" }),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "Old unit tests" })).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: "Retry Old unit tests",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("retries load errors while keeping the pipeline row available", async () => {
    request.mockRejectedValueOnce(new Error("Connection unavailable"));
    render(<GitLabPipelinesTable pipelines={[pipeline]} />);
    expand();
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("Connection unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh jobs" }));
    expect(
      await screen.findByRole("link", { name: "Unit tests" }),
    ).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("refreshes on matching pipeline events and reconnects but ignores other projects", async () => {
    render(<GitLabPipelinesTable pipelines={[pipeline]} />);
    expand();
    await screen.findByRole("link", { name: "Unit tests" });
    act(() =>
      next?.({
        data: { gitlabPipelineStatusChanged: { projectId: "22", id: "94" } },
      }),
    );
    expect(request).toHaveBeenCalledTimes(1);
    act(() =>
      next?.({
        data: { gitlabPipelineStatusChanged: { projectId: "21", id: "94" } },
      }),
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    act(() => recover?.());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });

  test("polls active expanded pipelines only while visible and stops after completion", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    render(
      <GitLabPipelinesTable pipelines={[pipeline]} pollIntervalSeconds={30} />,
    );
    expand();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(request).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValue({
      gitlabPipeline: { ...pipeline, status: "SUCCESS" },
      gitlabPipelineJobs: [{ ...job, status: "SUCCESS" }],
    } as never);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(request).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  test("guards job retries while a request is running and refreshes both details and parent", async () => {
    let finishRetry: (() => void) | undefined;
    const changed = vi.fn(async () => undefined);
    request.mockImplementation(async (query) => {
      if (query.includes("mutation RetryGitLabJob"))
        return await new Promise((resolve) => {
          finishRetry = () => resolve({ retryGitLabJob: { id: "2" } } as never);
        });
      return {
        gitlabPipeline: { ...pipeline, status: "FAILED" },
        gitlabPipelineJobs: [
          { ...job, status: "FAILED" },
          { ...job, id: "other-job", name: "Lint", status: "SUCCESS" },
        ],
      } as never;
    });
    render(
      <GitLabPipelinesTable
        pipelines={[{ ...pipeline, status: "FAILED" }]}
        onChanged={changed}
      />,
    );
    expand();
    const retry = await screen.findByRole("button", {
      name: "Retry Unit tests",
    });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation RetryGitLabJob"),
      ),
    ).toHaveLength(1);
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Retrying Unit tests…", { selector: "p" }),
    ).toBeDefined();
    expect(retry.querySelector('[data-slot="spinner"]')).not.toBeNull();
    const otherRetry = screen.getByRole("button", { name: "Retry Lint" });
    expect(otherRetry.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(otherRetry.getAttribute("title")).toBe(
      "Another action is in progress for this pipeline.",
    );
    expect(otherRetry.getAttribute("aria-describedby")).toBeTruthy();
    await act(async () => {
      finishRetry?.();
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("Retrying Unit tests…", { selector: "p" }),
    ).toBeNull();
    expect(retry.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("query GitLabPipelineDetails"),
      ),
    ).toHaveLength(2);
  });

  test.each([
    {
      status: "FAILED" as const,
      action: "Retry",
      progress: "Retrying pipeline…",
    },
    {
      status: "RUNNING" as const,
      action: "Cancel",
      progress: "Canceling pipeline…",
    },
  ])(
    "shows $action progress until the deferred action and refresh complete",
    async ({ status, action, progress }) => {
      let finish: (() => void) | undefined;
      request.mockImplementation(async (query) => {
        if (query.includes("mutation GitLabPipelineAction"))
          return await new Promise((resolve) => {
            finish = () => resolve({} as never);
          });
        return {
          gitlabPipeline: { ...pipeline, status },
          gitlabPipelineJobs: [],
        } as never;
      });
      render(<GitLabPipelinesTable pipelines={[{ ...pipeline, status }]} />);
      const trigger = screen.getByRole("button", {
        name: "Actions: #14 · feature/api",
      });
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(screen.getByRole("menuitem", { name: action }));
      expect(screen.getByText(progress)).toBeDefined();
      expect((trigger as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        finish?.();
      });
      expect(screen.queryByText(progress)).toBeNull();
      expect((trigger as HTMLButtonElement).disabled).toBe(false);
      expect(
        request.mock.calls.filter(([query]) =>
          query.includes("mutation GitLabPipelineAction"),
        ),
      ).toHaveLength(1);
    },
  );

  test("row links and menus do not activate expansion", async () => {
    render(<GitLabPipelinesTable pipelines={[pipeline]} />);
    const row = screen
      .getByRole("button", { name: "Show jobs for #14 · feature/api" })
      .closest("tr")!;
    fireEvent.click(
      within(row).getByRole("link", { name: "#14 · feature/api" }),
    );
    expect(request).not.toHaveBeenCalled();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions: #14 · feature/api" }),
      { button: 0, ctrlKey: false },
    );
    expect(
      screen
        .getByRole("menuitem", { name: "Retry" })
        .getAttribute("data-disabled"),
    ).toBe("");
    expect(
      screen.getByText("Only failed or canceled pipelines can be retried."),
    ).toBeDefined();
    expect(
      screen
        .getByRole("menuitem", { name: "Retry" })
        .getAttribute("aria-describedby"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("menuitem", { name: "Cancel" })
        .getAttribute("data-disabled"),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
