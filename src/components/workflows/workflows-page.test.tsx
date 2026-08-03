import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { downloadJsonFiles } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { WorkflowsPage } from "./workflows-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/lib/browser-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/browser-utils")>()),
  downloadJsonFiles: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const timestamp = "2026-07-25T12:00:00.000Z";

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

function workflowRun(
  id: string,
  displayNumber: number,
  archivedAt: string | null,
  status = "SUCCEEDED",
  createdAt = timestamp,
) {
  return {
    id,
    displayNumber,
    workflowId: "workflow-1",
    workflow: { id: "workflow-1", name: "Example workflow" },
    triggerKind: "MANUAL",
    triggerSubjectKey: "manual",
    status,
    phase: "FINISHED",
    generation: 1,
    blockedReason: null,
    error: null,
    queuedAt: createdAt,
    startedAt: createdAt,
    pausedAt: status === "PAUSED" ? createdAt : null,
    finishedAt: ["SUCCEEDED", "FAILED", "CANCELLED"].includes(status)
      ? createdAt
      : null,
    archivedAt,
    createdAt,
  };
}

function workflowSummary(id: string, name: string) {
  return {
    id,
    name,
    description: "",
    draftDefinition: {
      format: "aide.workflow",
      schemaVersion: 1,
      name,
      description: "",
      triggers: [],
      nodes: [],
      edges: [],
      editor: {},
    },
    activeVersionId: null,
    enabled: true,
    overlapPolicy: "QUEUE",
    maxConcurrentRuns: 1,
    completionNotificationsEnabled: true,
    exclusiveWorktree: false,
    quickActionKind: "NONE",
    quickActionIconKey: "zap",
    quickActionButtonVariant: "default",
    quickActionRepositories: [],
    triggerChoices: [],
    hasPlainTrigger: true,
    archivedAt: null,
    versionCount: 1,
    runCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function renderPage() {
  return render(
    <TooltipProvider>
      <WorkflowsPage />
    </TooltipProvider>,
  );
}

async function chooseArchiveFilter(option: string) {
  const trigger = screen.getByRole("combobox", { name: "Archive filter" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  subscriptions.mockReturnValue({
    subscribe: vi.fn(() => vi.fn()),
  } as never);
  request.mockImplementation(async (query, variables) => {
    if (String(query).includes("query WorkflowManagement")) {
      const archived = variables?.archive === "ARCHIVED";
      return {
        workflows: { items: [] },
        workflowRuns: {
          items: archived
            ? [workflowRun("archived-run", 202, timestamp)]
            : [workflowRun("active-run", 101, null)],
        },
      } as never;
    }
    throw new Error(`Unexpected request: ${String(query)}`);
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

describe("WorkflowsPage", () => {
  test("exports and deletes every workflow selected in edit mode", async () => {
    request.mockImplementation(async (query) => {
      const text = String(query);
      if (text.includes("query WorkflowManagement")) {
        return {
          workflows: {
            items: [
              workflowSummary("workflow-1", "Nightly Build"),
              workflowSummary("workflow-2", "Release"),
            ],
          },
          workflowRuns: { items: [] },
        } as never;
      }
      if (text.includes("query ExportWorkflow")) {
        return { exportWorkflow: { format: "aide.workflow.export" } } as never;
      }
      if (text.includes("mutation DeleteWorkflow")) {
        return { deleteWorkflow: true } as never;
      }
      throw new Error(`Unexpected request: ${text}`);
    });
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Workflows" }));
    expect(
      await screen.findByRole("link", { name: "Nightly Build" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));

    expect(
      screen
        .getByRole("checkbox", { name: "Select Nightly Build" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() =>
      expect(vi.mocked(downloadJsonFiles)).toHaveBeenCalledWith([
        expect.objectContaining({ filename: "nightly-build.workflow.json" }),
        expect.objectContaining({ filename: "release.workflow.json" }),
      ]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DeleteWorkflow"),
        { id: "workflow-2" },
      ),
    );
  });

  test("clears selected runs when the archive filter changes", async () => {
    renderPage();
    expect(await screen.findByRole("link", { name: "#101" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select run #101" }));
    expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(2);

    await chooseArchiveFilter("Archived");
    expect(await screen.findByRole("link", { name: "#202" })).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select run #202" }));
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("query WorkflowManagement"),
        { archive: "ARCHIVED" },
      ),
    );
  });

  test("shows queued, waiting, and paused runs before newer completed runs", async () => {
    request.mockImplementationOnce(
      async () =>
        ({
          workflows: { items: [] },
          workflowRuns: {
            items: [
              workflowRun("complete", 404, null),
              workflowRun("queued", 303, null, "QUEUED", timestamp),
              workflowRun("paused", 202, null, "PAUSED", timestamp),
              workflowRun("waiting", 101, null, "WAITING", timestamp),
            ],
          },
        }) as never,
    );

    renderPage();

    const runLinks = await screen.findAllByRole("link", { name: /^#\d+$/ });
    expect(runLinks.map((link) => link.textContent)).toEqual([
      "#303",
      "#202",
      "#101",
      "#404",
    ]);
    expect(screen.getAllByRole("cell", { name: "Active" })).toHaveLength(1);
    expect(screen.getAllByRole("cell", { name: /July 25, 2026/ })).toHaveLength(
      1,
    );
  });

  test("links a run's worktree and agent without showing generation", async () => {
    request.mockImplementationOnce(
      async () =>
        ({
          workflows: { items: [] },
          workflowRuns: {
            items: [
              {
                ...workflowRun("linked", 505, null),
                worktree: {
                  id: "worktree-1",
                  folder: "/tmp/repository/feature",
                  branch: "feature/AIDE-505",
                  highlightColor: null,
                },
                agent: { id: "agent-1", name: "Studio Mac" },
              },
            ],
          },
        }) as never,
    );

    renderPage();

    expect(
      (
        await screen.findByRole("link", { name: "feature/AIDE-505" })
      ).getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(
      screen.getByRole("link", { name: "Studio Mac" }).getAttribute("href"),
    ).toBe("/agents/agent-1");
    expect(screen.queryByRole("columnheader", { name: "Generation" })).toBe(
      null,
    );
    expect(
      screen
        .getAllByRole("columnheader")
        .map((header) => header.textContent)
        .filter(Boolean),
    ).toEqual([
      "Run",
      "Workflow",
      "Status",
      "Trigger",
      "Agent",
      "Worktree",
      "Started",
      "Actions",
    ]);
  });
});
