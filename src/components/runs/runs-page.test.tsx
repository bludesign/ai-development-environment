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
  onControlPlaneRecovery: vi.fn(() => () => undefined),
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
    catalogCost: null,
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
        run("complete", 404, "COMPLETED", timestamp),
        run("queued", 303, "QUEUED", timestamp),
        run("in-progress", 202, "IN_PROGRESS", timestamp),
        run("paused", 101, "PAUSED", timestamp),
      ],
      nextCursor: null,
      totalCount: 4,
    },
  } as never);
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

describe("RunsPage", () => {
  test.each(
    (["PLAN", "SESSION"] as const).flatMap((kind) =>
      ["CODEX", "CLAUDE", "OPENCODE"].map((provider) => ({ kind, provider })),
    ),
  )(
    "shows the catalog estimate for $provider on the $kind table",
    async ({ kind, provider }) => {
      request.mockResolvedValue({
        agentRuns: {
          items: [
            {
              ...run("imported", 1, "COMPLETED", timestamp),
              origin: "IMPORTED",
              provider,
              catalogCost: 1.25,
            },
          ],
          nextCursor: null,
          totalCount: 1,
        },
      } as never);
      render(
        <TooltipProvider>
          <RunsPage kind={kind} />
        </TooltipProvider>,
      );
      expect(await screen.findByRole("cell", { name: "$1.25" })).toBeDefined();
      const query = request.mock.calls.find(([query]) =>
        String(query).includes("query AgentRuns"),
      )?.[0];
      expect(query).toContain("catalogCost");
    },
  );

  test.each(
    (["PLAN", "SESSION"] as const).flatMap((kind) =>
      [0, 2.5].map((estimatedCost) => ({ kind, estimatedCost })),
    ),
  )(
    "prefers the reported cost of $estimatedCost on the $kind table",
    async ({ kind, estimatedCost }) => {
      request.mockResolvedValue({
        agentRuns: {
          items: [
            {
              ...run("reported", 1, "COMPLETED", timestamp),
              estimatedCost,
              catalogCost: 1.25,
            },
          ],
          nextCursor: null,
          totalCount: 1,
        },
      } as never);
      render(
        <TooltipProvider>
          <RunsPage kind={kind} />
        </TooltipProvider>,
      );
      expect(
        await screen.findByRole("cell", {
          name: estimatedCost === 0 ? "$0.00" : "$2.50",
        }),
      ).toBeDefined();
      expect(screen.queryByRole("cell", { name: "$1.25" })).toBeNull();
    },
  );

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
        "#303",
        "#202",
        "#101",
        "#404",
      ]);
      expect(screen.getAllByRole("cell", { name: "Active" })).toHaveLength(1);
      expect(
        screen.getAllByRole("cell", { name: /July 25, 2026/ }),
      ).toHaveLength(1);
    },
  );
});
