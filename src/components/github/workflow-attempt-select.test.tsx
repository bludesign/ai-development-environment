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
      startedAt: "2026-07-21T12:00:00.000Z",
      createdAt: "2026-07-21T12:00:00.000Z",
      updatedAt: "2026-07-21T12:01:00.000Z",
      jobs: [],
    };
    vi.mocked(controlPlaneRequest).mockResolvedValue({
      githubActionsWorkflowRunAttempt: historical,
    } as never);
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
    fireEvent.click(await screen.findByRole("option", { name: "Attempt 2" }));

    await waitFor(() =>
      expect(onAttemptChange).toHaveBeenCalledWith(historical),
    );
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("githubActionsWorkflowRunAttempt"),
      { repositoryId: "repository-1", workflowRunId: "77", attempt: 2 },
    );
  });
});
