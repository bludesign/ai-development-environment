import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { AutoRetryDialog } from "./auto-retry-dialog";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const request = vi.mocked(controlPlaneRequest);

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  request.mockReset();
});

describe("AutoRetryDialog", () => {
  test("loads current targets once and keeps jobs visible beneath a selected pipeline", async () => {
    request.mockResolvedValue({
      githubAutoRetryRules: [],
      githubSettings: { tokenConfigured: true },
      githubAppSettings: { configured: true, actionsPermission: "write" },
    } as never);

    render(
      <AutoRetryDialog
        codebaseRepositoryId="repository-1"
        currentRuns={[
          {
            id: "run-1",
            workflowId: "workflow-1",
            name: "CI",
            jobs: [
              {
                id: "job-1",
                name: "build-and-test",
                status: "SUCCESS",
                url: null,
                canRetry: true,
                retryUnavailableReason: null,
                steps: [],
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Auto Retry" }));

    const pipeline = await screen.findByRole("checkbox", { name: "CI" });
    const job = screen.getByRole("checkbox", { name: "build-and-test" });
    expect(pipeline.getAttribute("data-state")).toBe("checked");
    expect(job.getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(job);
    expect(pipeline.getAttribute("data-state")).toBe("unchecked");
    expect(job.getAttribute("data-state")).toBe("checked");

    await waitFor(() => {
      expect(
        request.mock.calls.filter(([query]) =>
          String(query).includes("query GitHubAutoRetryRules"),
        ),
      ).toHaveLength(1);
    });
  });

  test("loads repository workflows before editing a workflow-scoped future rule", async () => {
    const rule = {
      id: "rule-1",
      scope: "WORKTREE_BRANCH",
      codebaseRepositoryId: "repository-1",
      repositoryGithubId: "github-repository-1",
      worktreeId: "worktree-1",
      branch: "feature/APP-42",
      pullRequestNumber: null,
      allWorkflows: false,
      mode: "FAILURE",
      retryLimit: 3,
      failureStrategy: "FAILED_JOBS",
      status: "ACTIVE",
      enabled: true,
      lastError: null,
      targets: [
        {
          id: "target-1",
          workflowId: "workflow-1",
          workflowRunId: null,
          jobName: null,
        },
      ],
      executions: [],
      createdAt: "2026-07-21T12:00:00.000Z",
      updatedAt: "2026-07-21T12:00:00.000Z",
    } as const;
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query GitHubRepositoryWorkflows")) {
        return {
          githubRepositoryWorkflows: [
            {
              id: "workflow-1",
              name: "CI",
              path: ".github/workflows/ci.yml",
              state: "active",
              url: "https://github.com/acme/widgets/actions/workflows/ci.yml",
              jobNames: ["test"],
            },
          ],
        } as never;
      }
      return {
        githubAutoRetryRules: [rule],
        githubSettings: { tokenConfigured: true },
        githubAppSettings: { configured: true, actionsPermission: "write" },
      } as never;
    });

    render(
      <AutoRetryDialog
        allowFuture
        branch="feature/APP-42"
        codebaseRepositoryId="repository-1"
        worktreeId="worktree-1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Auto Retry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit rule" }));

    const workflow = await screen.findByRole("checkbox", { name: "CI" });
    expect(workflow.getAttribute("data-state")).toBe("checked");
    expect(
      request.mock.calls.some(([query]) =>
        String(query).includes("query GitHubRepositoryWorkflows"),
      ),
    ).toBe(true);
  });
});
