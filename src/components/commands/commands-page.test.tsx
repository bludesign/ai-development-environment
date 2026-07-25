import { cleanup, render, screen } from "@testing-library/react";
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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const timestamp = "2026-07-25T12:00:00.000Z";

beforeEach(() => {
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
    commandRuns: {
      nodes: [
        {
          id: "run-1",
          displayNumber: 42,
          commandId: "command-1",
          command: { id: "command-1", name: "Development server" },
          origin: "MANUAL",
          status: "SUCCEEDED",
          snapshotName: "Development server",
          agentId: "agent-1",
          agentName: "Studio",
          agentHostname: "studio.local",
          worktreeId: "worktree-1",
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
          queuedAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp,
          archivedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
  } as never);
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

describe("CommandsPage", () => {
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
});
