import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { PreparePage } from "./prepare-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const preparations = [
  {
    id: "preparation-env",
    kind: "WRITE",
    path: ".env.local",
    contentSha256: "abc",
    byteCount: 12,
    definitionHash: "definition-1",
  },
  {
    id: "preparation-delete",
    kind: "DELETE",
    path: "tmp/debug.flag",
    contentSha256: null,
    byteCount: null,
    definitionHash: "definition-2",
  },
] as const;

function overview(supported: boolean) {
  return {
    repositories: [
      {
        repository: {
          id: "repository-1",
          name: "Acme app",
          displayOrigin: "github.com/acme/app",
          preparations,
        },
        worktrees: [
          {
            worktree: {
              id: "worktree-1",
              folder: "/Users/acme/app-feature",
              relativePath: "app-feature",
              branch: "feature/search",
              headSha: "1234567890abcdef",
              primary: false,
              availability: "AVAILABLE",
            },
            agent: {
              id: "agent-1",
              name: "Studio Mac",
              hostname: "studio.local",
            },
            supported,
            unsupportedReason: supported ? null : "Agent must be updated",
            overallState: "DRIFTED",
            statuses: [
              {
                preparation: preparations[0],
                state: "APPLIED",
                message: null,
                checkedAt: new Date(0).toISOString(),
              },
              {
                preparation: preparations[1],
                state: "DRIFTED",
                message: "Managed file exists",
                checkedAt: new Date(0).toISOString(),
              },
            ],
            activeJob: null,
          },
        ],
      },
    ],
  };
}

describe("PreparePage", () => {
  beforeEach(() => {
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("renders persisted per-file colors and keeps unsupported worktrees visible", async () => {
    request.mockResolvedValue({
      worktreePreparationOverview: overview(false),
    } as never);

    render(<PreparePage />);

    expect(await screen.findByText("Acme app")).toBeDefined();
    expect(screen.getByText(".env.local")).toBeDefined();
    expect(screen.getByText("tmp/debug.flag")).toBeDefined();
    expect(screen.getByText("Applied").className).toContain("emerald");
    expect(screen.getAllByText("Drifted")[0]?.className).toContain(
      "destructive",
    );
    expect(screen.getAllByText("Studio Mac · studio.local").length).toBe(2);
    expect(screen.getByText("Agent must be updated")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  test("confirms a destructive per-worktree action before dispatching it", async () => {
    request.mockImplementation(async (query, variables) => {
      if (String(query).includes("query WorktreePreparationOverview")) {
        return { worktreePreparationOverview: overview(true) } as never;
      }
      if (String(query).includes("mutation RunWorktreePreparations")) {
        const action = (variables as { input?: { action?: string } }).input
          ?.action;
        return {
          runWorktreePreparations: {
            jobs: action === "APPLY" ? [{ id: "job-1" }] : [],
            skipped: [],
          },
        } as never;
      }
      if (String(query).includes("query WorktreeJob")) {
        return {
          agentJob: {
            status: "SUCCEEDED",
            error: null,
            worktreeOperationResult: null,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<PreparePage />);

    const apply = await screen.findByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply.hasAttribute("disabled")).toBe(false));
    expect(screen.getAllByRole("button", { name: "Apply all" })).toHaveLength(
      2,
    );
    expect(
      screen.getByRole("button", { name: "Undo" }).getAttribute("data-variant"),
    ).toBe("outline");
    fireEvent.click(apply);

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Apply repository preparations?"),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("mutation RunWorktreePreparations") &&
            (variables as { input?: { action?: string } }).input?.action ===
              "APPLY",
        ),
      ).toBe(true),
    );
    await waitFor(
      () =>
        expect(
          request.mock.calls.some(([query]) =>
            String(query).includes("query WorktreeJob"),
          ),
        ).toBe(true),
      { timeout: 2500 },
    );
  });
});
