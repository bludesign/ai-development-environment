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
});
