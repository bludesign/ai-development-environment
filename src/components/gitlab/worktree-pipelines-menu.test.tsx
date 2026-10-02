import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitLabPipelineView } from "@/services/gitlab";

import { GitLabWorktreePipelinesMenu } from "./worktree-pipelines-menu";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const pipeline: GitLabPipelineView = {
  id: "94",
  projectId: "21",
  iid: "14",
  ref: "refs/merge-requests/17/head",
  branch: "feature/api",
  sha: "abcdef12",
  source: "merge_request_event",
  status: "FAILED",
  canRetry: true,
  webUrl: "https://gitlab.example/group/app/-/pipelines/94",
  mergeRequests: [],
  worktreeId: "worktree-1",
  worktreeHighlightColor: null,
  startedAt: null,
  createdAt: null,
  updatedAt: null,
  finishedAt: null,
  duration: null,
  queuedDuration: null,
};

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  request.mockResolvedValue({
    runGitLabPipelineAction: { pipeline: { id: pipeline.id }, execution: null },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openMenu() {
  fireEvent.pointerDown(screen.getByRole("button", { name: /^Pipelines:/ }), {
    button: 0,
    ctrlKey: false,
  });
}

describe("GitLab worktree pipeline menu", () => {
  test("retries a native pipeline and refreshes the worktree without activating the card", async () => {
    const onChanged = vi.fn(async () => undefined);
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <GitLabWorktreePipelinesMenu
          onChanged={onChanged}
          pipelines={[pipeline]}
        />
      </div>,
    );
    openMenu();
    expect(
      screen
        .getByRole("menuitem", { name: "#14 · refs/merge-requests/17/head" })
        .getAttribute("href"),
    ).toBe(pipeline.webUrl);
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("runGitLabPipelineAction"),
      { projectId: "21", pipelineId: "94" },
    );
    expect(request.mock.calls[0]?.[0]).toContain("action: RETRY");
    expect(onCardClick).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeDefined();
  });

  test("allows retrying successful external work according to server capabilities", async () => {
    request.mockResolvedValue({
      runGitLabPipelineAction: {
        execution: {
          status: "ACCEPTED",
          message: "Action request completed; awaiting provider status updates",
        },
      },
    } as never);
    render(
      <GitLabWorktreePipelinesMenu
        pipelines={[{ ...pipeline, status: "SUCCESS" }]}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "ACCEPTED: Action request completed; awaiting provider status updates",
    );
    expect(screen.getByLabelText("Pipelines: Success")).toBeDefined();
  });

  test.each(["FAILED", "SUCCESS", "RUNNING"] as const)(
    "disables retry for %s when the server reports no eligible work",
    (status) => {
      render(
        <GitLabWorktreePipelinesMenu
          pipelines={[{ ...pipeline, status, canRetry: false }]}
        />,
      );
      openMenu();
      const retry = screen.getByRole("menuitem", {
        name: "Retry",
      });
      expect(retry.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(retry);
      expect(request).not.toHaveBeenCalled();
    },
  );

  test("prevents repeated clicks while dispatching and refreshing, then displays refreshed status", async () => {
    let finish!: (value: unknown) => void;
    request.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)) as never,
    );
    let finishRefresh!: () => void;
    const onChanged = vi.fn(
      () => new Promise<void>((resolve) => (finishRefresh = resolve)),
    );
    const view = render(
      <GitLabWorktreePipelinesMenu
        onChanged={onChanged}
        pipelines={[pipeline]}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    const pending = screen.getByRole("menuitem", {
      name: "Retrying…",
    });
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(pending);
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ runGitLabPipelineAction: { execution: null } });
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(pending.getAttribute("aria-disabled")).toBe("true");
    view.rerender(
      <GitLabWorktreePipelinesMenu
        onChanged={onChanged}
        pipelines={[{ ...pipeline, status: "PENDING", canRetry: false }]}
      />,
    );
    await act(async () => finishRefresh());
    expect(screen.getByLabelText("Pipelines: Pending")).toBeDefined();
    expect(
      screen
        .getByRole("menuitem", {
          name: "Retry",
        })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  test.each(["FAILED", "PARTIAL", "UNCERTAIN"])(
    "shows %s execution results and refreshes the worktree",
    async (status) => {
      const onChanged = vi.fn(async () => undefined);
      request.mockResolvedValue({
        runGitLabPipelineAction: {
          execution: {
            status,
            message: "Provider did not confirm the request",
          },
        },
      } as never);
      render(
        <GitLabWorktreePipelinesMenu
          onChanged={onChanged}
          pipelines={[pipeline]}
        />,
      );
      openMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
      expect((await screen.findByRole("alert")).textContent).toBe(
        `${status}: Provider did not confirm the request`,
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    },
  );

  test("supports reaching Retry with the keyboard and keeps the menu open during the action", async () => {
    render(<GitLabWorktreePipelinesMenu pipelines={[pipeline]} />);
    openMenu();
    const retry = screen.getByRole("menuitem", { name: "Retry" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(retry));
    fireEvent.keyDown(retry, { key: "Enter" });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("menu")).toBeDefined();
  });

  test("shows request errors and clears them after a subsequent retry succeeds", async () => {
    request.mockRejectedValueOnce(new Error("Configure a retry script"));
    render(<GitLabWorktreePipelinesMenu pipelines={[pipeline]} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Configure a retry script",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
