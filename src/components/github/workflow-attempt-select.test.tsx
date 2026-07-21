import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { WorkflowAttemptSelect } from "./workflow-attempt-select";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});

afterEach(() => {
  cleanup();
  vi.mocked(controlPlaneRequest).mockReset();
});

describe("WorkflowAttemptSelect", () => {
  test("loads a historical attempt lazily", async () => {
    const historical = {
      workflowRunId: "77",
      runAttempt: 2,
      status: "FAILURE" as const,
      url: "https://github.com/acme/widgets/actions/runs/77/attempts/2",
      triggeringActor: {
        login: "octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        url: "https://github.com/octocat",
      },
      startedAt: "2026-07-21T12:00:00.000Z",
      createdAt: "2026-07-21T12:00:00.000Z",
      updatedAt: "2026-07-21T12:01:00.000Z",
      jobs: [],
    };
    vi.mocked(controlPlaneRequest).mockImplementation(
      async (_query, variables) => ({
        githubActionsWorkflowRunAttempt: {
          ...historical,
          runAttempt: Number(variables?.attempt),
          status: variables?.attempt === 3 ? "SUCCESS" : "FAILURE",
        },
      }),
    );
    const onAttemptChange = vi.fn();

    render(
      <WorkflowAttemptSelect
        latestAttempt={3}
        onAttemptChange={onAttemptChange}
        repositoryId="repository-1"
        workflowRunId="77"
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    const passed = await screen.findByText("Passed");
    expect(passed.parentElement?.textContent).toBe("Latest — Attempt 3Passed");
    const actors = await screen.findAllByText(/Started by @octocat/);
    expect(actors).toHaveLength(3);
    expect(actors[0]?.parentElement?.textContent).not.toContain("2026");
    fireEvent.click(await screen.findByRole("option", { name: /Attempt 2/ }));

    await waitFor(() =>
      expect(onAttemptChange).toHaveBeenCalledWith({
        ...historical,
        runAttempt: 2,
      }),
    );
    expect(controlPlaneRequest).toHaveBeenCalledTimes(4);
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("triggeringActor { login avatarUrl url }"),
      expect.objectContaining({
        repositoryId: "repository-1",
        workflowRunId: "77",
        attempt: 2,
      }),
    );
    expect(controlPlaneRequest).toHaveBeenLastCalledWith(
      expect.stringContaining("jobs { id name status"),
      expect.objectContaining({ attempt: 2 }),
    );
  });
});
