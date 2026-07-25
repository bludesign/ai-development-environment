import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import {
  WorkflowResourceMenuItems,
  type WorkflowMenuResource,
} from "./workflow-resource-actions";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const resource: WorkflowMenuResource = {
  kind: "GITHUB_PIPELINE",
  id: "repository-1:run:44",
  repositoryId: "repository-1",
  sessionData: {
    repo: { id: "repository-1" },
    pipeline: { id: "44" },
  },
};

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

test("caches matching GitHub quick actions and launches them from menus", async () => {
  request.mockImplementation(async (query) => {
    if (query.includes("GitHubWorkflowQuickActions")) {
      return {
        workflowQuickActions: [
          {
            id: "workflow-1",
            name: "Inspect run",
            description: "Inspect this pipeline",
            quickActionIconKey: "search",
            triggerChoices: [],
            hasPlainTrigger: true,
          },
        ],
      } as never;
    }
    if (query.includes("TriggerGitHubResourceWorkflow")) {
      return { triggerWorkflow: { id: "run-1" } } as never;
    }
    throw new Error(`Unexpected request: ${query}`);
  });
  subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
  const onOpenLinked = vi.fn();
  const onError = vi.fn();

  render(
    <>
      {["first", "second"].map((key) => (
        <DropdownMenu key={key} modal={false} open>
          <DropdownMenuTrigger asChild>
            <Button>{key}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <WorkflowResourceMenuItems
              onError={onError}
              onOpenLinked={onOpenLinked}
              resource={resource}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </>,
  );

  expect(
    await screen.findAllByRole("menuitem", { name: "Inspect run" }),
  ).toHaveLength(2);
  expect(
    request.mock.calls.filter(([query]) =>
      String(query).includes("GitHubWorkflowQuickActions"),
    ),
  ).toHaveLength(1);

  fireEvent.click(screen.getAllByRole("menuitem", { name: "Inspect run" })[0]!);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("TriggerGitHubResourceWorkflow"),
      {
        input: {
          workflowId: "workflow-1",
          sessionData: resource.sessionData,
          resourceKind: "GITHUB_PIPELINE",
          resourceId: "repository-1:run:44",
          subjectKey: "GITHUB_PIPELINE:repository-1:run:44",
          choice: null,
        },
      },
    ),
  );
  fireEvent.click(
    screen.getAllByRole("menuitem", { name: "Linked workflows" })[0]!,
  );
  expect(onOpenLinked).toHaveBeenCalledOnce();
});
