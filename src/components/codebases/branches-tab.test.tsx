import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import { BranchesTab } from "./branches-tab";
import type { CodebaseRepository } from "./types";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
const repositories = (count = 2): CodebaseRepository[] =>
  [
    {
      id: "repo",
      name: "App",
      codebases: [
        {
          id: "checkout",
          folder: "/repo",
          branch: "main",
          defaultBranch: "main",
          availability: "AVAILABLE",
          activeJob: null,
          agent: {
            id: "agent",
            name: "Build Mac",
            connectionStatus: "ONLINE",
            capabilities: ["codebase.branches.delete"],
          },
          localBranchInventory: {
            scannedAt: "2026-10-01T00:00:00Z",
            branches: Array.from({ length: count }, (_, index) => ({
              name: `old-${index}`,
              headSha: "a".repeat(40),
              lastCommitAt: "2026-01-01T00:00:00Z",
              lastCommitMessage: "Old work",
              current: false,
              checkedOutPath: null,
            })),
          },
        },
      ],
    },
  ] as unknown as CodebaseRepository[];
const reload = vi.fn(async () => {});
const refresh = vi.fn(async () => {});
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverMock;
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  request.mockResolvedValue({
    deleteCodebaseBranches: { jobs: [], skipped: [] },
  } as never);
});
afterEach(cleanup);

describe("branch cleanup tab", () => {
  test("selects eligible branches across pages and cancels review without dispatching deletion", () => {
    render(
      <BranchesTab
        repositories={repositories(51)}
        onReload={reload}
        onRefresh={refresh}
      />,
    );
    expect(screen.getAllByRole("row")).toHaveLength(51);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all matching eligible branches",
      }),
    );
    expect(screen.getByText("51 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(
      within(screen.getByRole("dialog")).getAllByRole("listitem"),
    ).toHaveLength(51);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(request).not.toHaveBeenCalled();
  });
  test("requires a separate force confirmation and preserves per-branch partial results", async () => {
    request.mockResolvedValue({
      deleteCodebaseBranches: {
        jobs: [
          {
            id: "job",
            codebaseId: "checkout",
            status: "SUCCEEDED",
            error: null,
            branchDeletionResults: [
              {
                codebaseId: "checkout",
                branch: "old-0",
                outcome: "DELETED",
                reason: null,
              },
              {
                codebaseId: "checkout",
                branch: "old-1",
                outcome: "FAILED",
                reason: "Branch tip changed",
              },
            ],
          },
        ],
        skipped: [],
      },
    } as never);
    render(
      <BranchesTab
        repositories={repositories()}
        onReload={reload}
        onRefresh={refresh}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all matching eligible branches",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Force delete unmerged branches" }),
    );
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Allow force deletion",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete selected",
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Deleted locally")).toBeTruthy(),
    );
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Branch tip changed")).toBeTruthy();
    expect(request.mock.calls[0]![1]).toMatchObject({
      input: {
        force: true,
        targets: [
          {
            codebaseId: "checkout",
            branch: "old-0",
            expectedHeadSha: "a".repeat(40),
          },
          {
            codebaseId: "checkout",
            branch: "old-1",
            expectedHeadSha: "a".repeat(40),
          },
        ],
      },
    });
  });
  test("disables protected and offline rows and drops selections after a tip changes", async () => {
    const data = repositories();
    data[0]!.codebases[0]!.localBranchInventory!.branches[0]!.current = true;
    const { rerender } = render(
      <BranchesTab repositories={data} onReload={reload} onRefresh={refresh} />,
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Select old-0/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Select old-1/ }));
    expect(screen.getByText("1 selected")).toBeTruthy();
    const changed = repositories();
    changed[0]!.codebases[0]!.localBranchInventory!.branches[1]!.headSha =
      "b".repeat(40);
    rerender(
      <BranchesTab
        repositories={changed}
        onReload={reload}
        onRefresh={refresh}
      />,
    );
    await waitFor(() => expect(screen.getByText("0 selected")).toBeTruthy());
    const offline = repositories();
    offline[0]!.codebases[0]!.agent.connectionStatus = "OFFLINE";
    rerender(
      <BranchesTab
        repositories={offline}
        onReload={reload}
        onRefresh={refresh}
      />,
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Select old-1/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
