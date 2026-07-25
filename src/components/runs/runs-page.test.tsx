import { cleanup, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { TooltipProvider } from "@/components/ui/tooltip";

import { RunsPage } from "./runs-page";

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
  useRouter: () => ({ push: vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const timestamp = "2026-07-25T12:00:00.000Z";

function run(
  id: string,
  displayNumber: number,
  status: string,
  createdAt: string,
) {
  return {
    id,
    displayNumber,
    status,
    phase: status,
    origin: "MANAGED",
    provider: "CODEX",
    worktree: null,
    jiraIssueKey: null,
    repositoryName: "Example repository",
    branch: "main",
    model: "gpt-5.6",
    effort: "medium",
    initialPrompt: `Prompt for ${id}`,
    finalOutput: status === "COMPLETED" ? "Done" : null,
    estimatedCost: null,
    sourcePlan: null,
    sourcePlanNumber: null,
    playedAt: null,
    archivedAt: null,
    createdAt,
  };
}

beforeEach(() => {
  subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
  request.mockResolvedValue({
    agentRuns: {
      items: [
        run("complete", 303, "COMPLETED", timestamp),
        run("in-progress", 202, "IN_PROGRESS", "2026-07-24T12:00:00.000Z"),
        run("paused", 101, "PAUSED", "2026-07-23T12:00:00.000Z"),
      ],
      nextCursor: null,
      totalCount: 3,
    },
  } as never);
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

describe("RunsPage", () => {
  test.each(["PLAN", "SESSION"] as const)(
    "shows active %s rows before newer completed rows",
    async (kind) => {
      render(
        <TooltipProvider>
          <RunsPage kind={kind} />
        </TooltipProvider>,
      );

      const runLinks = await screen.findAllByRole("link", { name: /^#\d+$/ });
      expect(runLinks.map((link) => link.textContent)).toEqual([
        "#202",
        "#101",
        "#303",
      ]);
    },
  );
});
