import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { CommandsPage } from "./commands-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
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
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const push = vi.fn();
const timestamp = "2026-07-25T12:00:00.000Z";

function commandRun({
  id = "run-1",
  displayNumber = 42,
  status = "SUCCEEDED",
  createdAt = timestamp,
} = {}) {
  return {
    id,
    displayNumber,
    commandId: "command-1",
    command: { id: "command-1", name: "Development server" },
    origin: "MANUAL",
    status,
    snapshotName: "Development server",
    agentId: "agent-1",
    agentName: "Studio",
    agentHostname: "studio.local",
    worktreeId: "worktree-1",
    worktree: {
      id: "worktree-1",
      folder: "/code/project",
      branch: "feature/AIDE-75",
      highlightColor: "violet",
    },
    worktreePath: "/code/project",
    worktreeBranch: "feature/AIDE-75",
    restartCount: 0,
    stopRequested: false,
    nextRestartAt: null,
    predecessorRunId: null,
    error: null,
    exitCode: 0,
    signal: null,
    attempts: [],
    queuedAt: createdAt,
    startedAt: createdAt,
    finishedAt: status === "RUNNING" ? null : createdAt,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

beforeEach(() => {
  push.mockReset();
  subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
  request.mockResolvedValue({
    commandDefinitions: [],
    agents: [
      {
        id: "agent-1",
        name: "Studio",
        hostname: "studio.local",
        connectionStatus: "ONLINE",
        capabilities: ["command.run"],
      },
    ],
    worktreeOverview: { agents: [] },
    commandRuns: { nodes: [commandRun()] },
  } as never);
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

describe("CommandsPage", () => {
  test("shows table and card skeletons while commands are loading", () => {
    request.mockReturnValue(new Promise(() => undefined));

    const { container } = render(<CommandsPage />);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      5,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Definitions" }));
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      15,
    );
  });

  test("links command runs and their concrete worktrees", async () => {
    render(<CommandsPage />);
    expect(
      (await screen.findByRole("link", { name: "#42" })).getAttribute("href"),
    ).toBe("/commands/runs/run-1");
    expect(
      screen
        .getByRole("link", { name: "feature/AIDE-75" })
        .getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
  });

  test("opens a run from the row and uses session-style link highlights", async () => {
    render(<CommandsPage />);

    const command = await screen.findByRole("link", {
      name: "Development server",
    });
    const agent = screen.getByRole("link", { name: "Studio" });
    expect(command.className).toContain("hover:bg-muted");
    expect(agent.className).toContain("hover:bg-muted");

    fireEvent.click(screen.getByText("Succeeded"));
    expect(push).toHaveBeenCalledWith("/commands/runs/run-1");
  });

  test("tints worktree command rows with their configured highlight color", async () => {
    render(<CommandsPage />);

    const row = (await screen.findByText("Succeeded")).closest("tr");
    expect(row?.className).toContain("bg-violet-500/10");
    expect(row?.className).toContain("hover:bg-violet-500/20");
    expect(request.mock.calls[0]?.[0]).toContain(
      "worktree { id folder branch highlightColor }",
    );
  });

  test("selects completed runs from the current day in edit mode", async () => {
    render(<CommandsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dayCheckbox = screen.getByRole("checkbox", {
      name: /Select completed runs from/,
    });
    fireEvent.click(dayCheckbox);

    const rowCheckbox = screen.getAllByRole("checkbox")[2];
    expect(dayCheckbox.getAttribute("aria-checked")).toBe("true");
    expect(rowCheckbox.getAttribute("aria-checked")).toBe("true");
  });

  test("shows running commands before newer completed commands", async () => {
    request.mockResolvedValueOnce({
      commandDefinitions: [],
      agents: [],
      worktreeOverview: { agents: [] },
      commandRuns: {
        nodes: [
          commandRun({ id: "complete", displayNumber: 43 }),
          commandRun({
            id: "running",
            displayNumber: 41,
            status: "RUNNING",
            createdAt: "2026-07-24T12:00:00.000Z",
          }),
        ],
      },
    } as never);

    render(<CommandsPage />);

    const runLinks = await screen.findAllByRole("link", { name: /^#\d+$/ });
    expect(runLinks.map((link) => link.textContent)).toEqual(["#41", "#43"]);
  });
});
