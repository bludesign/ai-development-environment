import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { AppsPage } from "./apps-page";
import type { ManagedApp } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => () => undefined),
  controlPlaneSubscriptions: () => ({ subscribe: () => vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);

function app(
  id: string,
  name: string,
  counts: Pick<ManagedApp["counts"], "worktrees" | "dirtyWorktrees"> &
    Partial<Pick<ManagedApp["counts"], "nonMainWorktrees" | "openRequests">>,
): ManagedApp {
  return {
    id,
    name,
    description: "",
    agentIds: [],
    repositories: [],
    counts: {
      repositories: 0,
      codebases: 0,
      nonMainWorktrees: 0,
      openRequests: 0,
      plans: 0,
      sessions: 0,
      builds: 0,
      ...counts,
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("AppsPage", () => {
  test("shows dirty worktrees immediately before all worktrees only when needed", async () => {
    request.mockResolvedValue({
      apps: [
        app("dirty-app", "Dirty app", {
          worktrees: 4,
          dirtyWorktrees: 2,
          nonMainWorktrees: 3,
          openRequests: 1,
        }),
        app("clean-app", "Clean app", {
          worktrees: 3,
          dirtyWorktrees: 0,
        }),
      ],
      codebaseOverview: { repositories: [] },
    } as never);

    render(<AppsPage />);

    const dirtyCard = (
      await screen.findByText("Dirty app")
    ).closest<HTMLElement>('[data-slot="card"]');
    const cleanCard = screen
      .getByText("Clean app")
      .closest<HTMLElement>('[data-slot="card"]');
    expect(dirtyCard).not.toBeNull();
    expect(cleanCard).not.toBeNull();

    expect(within(dirtyCard!).getByText("Dirty worktrees")).toBeDefined();
    expect(within(cleanCard!).queryByText("Dirty worktrees")).toBeNull();

    const worktreeLinks = dirtyCard!.querySelectorAll(
      'a[href="/dashboard/apps/dirty-app?view=worktrees"]',
    );
    expect(worktreeLinks).toHaveLength(4);
    expect(worktreeLinks[0]?.textContent).toContain("Dirty worktrees");
    expect(worktreeLinks[1]?.textContent).toContain("Worktrees");
    expect(worktreeLinks[2]?.textContent).toBe("3Worktrees off main");
    expect(worktreeLinks[3]?.textContent).toBe("1Open PRs");
    expect(within(dirtyCard!).queryByText("Plans")).toBeNull();
    expect(within(dirtyCard!).queryByText("Sessions")).toBeNull();
    expect(
      within(cleanCard!).queryByRole("link", { name: "0 Worktrees off main" }),
    ).toBeNull();
    expect(
      within(cleanCard!).getByRole("link", { name: "0 Open PRs" }),
    ).toBeDefined();
  });

  test.each([
    [0, 0, 2],
    [1, 0, 3],
    [0, 1, 3],
    [1, 1, 4],
  ])(
    "fits the visible counts when dirty=%s and off-main=%s",
    async (dirtyWorktrees, nonMainWorktrees, columns) => {
      request.mockResolvedValue({
        apps: [
          app("app-1", "Example app", {
            worktrees: 2,
            dirtyWorktrees,
            nonMainWorktrees,
          }),
        ],
      } as never);
      render(<AppsPage />);
      const card = (
        await screen.findByText("Example app")
      ).closest<HTMLElement>('[data-slot="card"]')!;
      const counts = within(card)
        .getByText("Worktrees")
        .closest("a")!.parentElement!;
      expect(counts.children).toHaveLength(columns);
      expect(counts.className.split(/\s+/)).toContain(`grid-cols-${columns}`);
      expect(within(card).queryByText("Worktrees off main") !== null).toBe(
        nonMainWorktrees > 0,
      );
    },
  );

  test("anchors each footer to the bottom of its stretched grid card", async () => {
    request.mockResolvedValue({
      apps: [
        app("first-app", "First app", {
          worktrees: 1,
          dirtyWorktrees: 0,
        }),
        app("second-app", "Second app", {
          worktrees: 2,
          dirtyWorktrees: 1,
        }),
      ],
      codebaseOverview: { repositories: [] },
    } as never);

    render(<AppsPage />);

    const firstCard = (
      await screen.findByText("First app")
    ).closest<HTMLElement>('[data-slot="card"]');
    const footer = firstCard?.querySelector<HTMLElement>(
      '[data-slot="card-footer"]',
    );

    expect(footer?.className.split(/\s+/)).toContain("mt-auto");
  });
});
