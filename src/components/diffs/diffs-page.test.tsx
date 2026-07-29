import {
  cleanup,
  fireEvent,
  render as renderBare,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { DiffsPage } from "./diffs-page";

/** The file list's tooltips need the provider the app layout supplies. */
function render(ui: ReactElement) {
  return renderBare(ui, { wrapper: TooltipProvider });
}

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

// The coverage picker is a Radix select, which drives pointer capture APIs jsdom
// does not implement.
Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PATCH = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
 keep
-old line
+new line
`;

const overview = {
  worktreeOverview: {
    agents: [
      {
        codebases: [
          {
            repository: { id: "r1", name: "Acme Web", displayOrigin: "acme" },
            codebase: { id: "c1", folder: "/repos/web", defaultBranch: "main" },
            worktrees: [
              {
                id: "w1",
                branch: "feature/search",
                relativePath: "trees/search",
                folder: "/repos/web-search",
                headSha: "abc1234",
                codeStateHash: "state-current",
                baseBranch: "main",
                availability: "AVAILABLE",
                pullRequest: null,
              },
            ],
          },
        ],
      },
    ],
  },
};

const detail = {
  inspectWorktree: {
    commits: [
      {
        sha: "aaaaaaa1111",
        subject: "Add search",
        authorName: "Dana",
        authoredAt: "2026-07-20T10:00:00.000Z",
        additions: 10,
        deletions: 2,
      },
    ],
    changes: [
      {
        path: "src/staged.ts",
        previousPath: null,
        changeType: "M",
        staged: true,
        unstaged: false,
        untracked: false,
        conflicted: false,
        stagedAdditions: 3,
        stagedDeletions: 1,
        unstagedAdditions: null,
        unstagedDeletions: null,
      },
    ],
    branchChanges: [
      {
        path: "src/app.ts",
        previousPath: null,
        changeType: "M",
        additions: 1,
        deletions: 1,
        binary: false,
        image: false,
      },
      {
        path: "src/zebra.ts",
        previousPath: null,
        changeType: "A",
        additions: 9,
        deletions: 0,
        binary: false,
        image: false,
      },
    ],
    commitsTruncated: false,
    changesTruncated: false,
    branchChangesTruncated: false,
  },
};

/**
 * Branch-scope files the detail query answers with for the running test. Reset
 * each time, so a test that needs deeper paths can just push onto it.
 */
let branchChanges = detail.inspectWorktree.branchChanges;

let commitDiff = {
  files: [] as Array<{
    path: string;
    previousPath: string | null;
    changeType: string;
    additions: number;
    deletions: number;
    binary: boolean;
    image: boolean;
  }>,
  patch: PATCH,
  image: false,
  binary: false,
  truncated: false,
  beforeAvailable: true,
  afterAvailable: true,
};

/** Two reports, one still running — only the ready one may be offered. */
const coverageReports = {
  worktreeCoverageReports: [
    {
      id: "report-1",
      status: "READY",
      createdAt: "2026-07-21T09:00:00.000Z",
      finishedAt: "2026-07-21T09:05:00.000Z",
      coverageSummary: { lineCoverage: 0.82, changedLineCoverage: 0.5 },
      // Matches the worktree head, so this report is not stale.
      build: {
        id: "build-1",
        snapshot: {
          worktree: {
            headSha: "abc1234",
            codeStateHash: "state-current",
          },
        },
      },
    },
    {
      id: "report-2",
      status: "PENDING",
      createdAt: "2026-07-22T09:00:00.000Z",
      finishedAt: null,
      coverageSummary: null,
      build: {
        id: "build-2",
        snapshot: {
          worktree: {
            headSha: "abc1234",
            codeStateHash: "state-current",
          },
        },
      },
    },
  ],
};

/**
 * The patch's new revision has `keep` on line 1 and `new line` on line 2, so
 * this report marks the first covered and the second uncovered.
 */
const coverageReport = {
  build: {
    reports: [
      {
        id: "report-1",
        kind: "CODE_COVERAGE",
        status: "READY",
        coverageFiles: [
          {
            target: "AppCore",
            path: "/repos/web-search/src/app.ts",
            lineCoverage: 0.5,
          },
        ],
        changedCoverageFiles: [
          {
            path: "src/app.ts",
            coveredLineNumbers: [1],
            uncoveredLineNumbers: [2],
          },
        ],
      },
    ],
  },
};

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
  branchChanges = detail.inspectWorktree.branchChanges;
  commitDiff = {
    files: [],
    patch: PATCH,
    image: false,
    binary: false,
    truncated: false,
    beforeAvailable: true,
    afterAvailable: true,
  };
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query DiffWorktrees")) return overview as never;
    // Checked before the singular query, whose name is a prefix of this one.
    if (operation.includes("query DiffCoverageReports"))
      return coverageReports as never;
    if (operation.includes("query DiffCoverageReport"))
      return coverageReport as never;
    if (operation.includes("mutation DiffWorktreeDetail"))
      return {
        inspectWorktree: { ...detail.inspectWorktree, branchChanges },
      } as never;
    if (operation.includes("mutation InspectWorktreeDiff")) {
      return { inspectWorktreeDiff: commitDiff } as never;
    }
    throw new Error(`unexpected operation: ${operation.slice(0, 40)}`);
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

/**
 * The selected path also appears in the diff pane header, so file-list
 * assertions scope to the list itself. Awaited, because the list only exists
 * once the worktree and its detail have loaded.
 */
async function fileList() {
  return within(await screen.findByRole("list", { name: "Files" }));
}

/** File rows in display order; folder rows carry no `aria-current`. */
async function fileRows() {
  return (await fileList())
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-current"))
    .map((button) => button.textContent ?? "");
}

describe("DiffsPage", () => {
  test("defaults to the branch scope and lists its changed files", async () => {
    render(<DiffsPage />);
    const list = await fileList();
    // Names lose their folders — the enclosing group owns them.
    expect(list.getByText("src")).toBeTruthy();
    expect(list.getByText("app.ts")).toBeTruthy();
    expect(list.getByText("zebra.ts")).toBeTruthy();
    // Staged-only files must not leak into the branch scope.
    expect(list.queryByText("staged.ts")).toBeNull();
  });

  test("groups nested paths and merges folders holding only a folder", async () => {
    branchChanges = [
      ...detail.inspectWorktree.branchChanges,
      {
        path: "src/components/diffs/pane.ts",
        previousPath: null,
        changeType: "A",
        additions: 4,
        deletions: 0,
        binary: false,
        image: false,
      },
    ];
    render(<DiffsPage />);
    const list = await fileList();
    // `components` holds nothing but `diffs`, so the two render as one row.
    expect(list.getByText("components/diffs")).toBeTruthy();
    expect(list.queryByText("components")).toBeNull();
    expect(list.getByText("pane.ts")).toBeTruthy();
  });

  test("hides a folder's files while it is collapsed", async () => {
    render(<DiffsPage />);
    const list = await fileList();
    fireEvent.click(list.getByRole("button", { expanded: true }));
    expect(list.queryByText("app.ts")).toBeNull();
    fireEvent.click(list.getByRole("button", { expanded: false }));
    expect(list.getByText("app.ts")).toBeTruthy();
  });

  test("renders the selected file's diff", async () => {
    render(<DiffsPage />);
    expect(await screen.findByText("new line")).toBeTruthy();
    expect(screen.getByText("old line")).toBeTruthy();
  });

  test("switches the file list when the scope changes", async () => {
    render(<DiffsPage />);
    await fileList();
    fireEvent.click(screen.getByRole("tab", { name: "Staged" }));
    const list = await fileList();
    expect(list.getByText("staged.ts")).toBeTruthy();
    expect(list.queryByText("zebra.ts")).toBeNull();
  });

  test("filters the file list by the search box", async () => {
    render(<DiffsPage />);
    await fileList();
    fireEvent.change(screen.getByLabelText("Search files"), {
      target: { value: "zebra" },
    });
    const list = await fileList();
    expect(list.queryByText("app.ts")).toBeNull();
    expect(list.getByText("zebra.ts")).toBeTruthy();
  });

  test("reverses the file order when the sort direction toggles", async () => {
    render(<DiffsPage />);
    expect((await fileRows())[0]).toContain("app.ts");
    fireEvent.click(screen.getByRole("button", { name: "Sort ascending" }));
    expect((await fileRows())[0]).toContain("zebra.ts");
  });

  test("wraps long lines until the query string opts out", async () => {
    const wrapToggle = () =>
      screen.getByRole("button", { name: "Toggle line wrapping" });
    const { container, unmount } = render(<DiffsPage />);
    // The toggle renders before the patch arrives, so wait on the diff itself.
    await screen.findByText("new line");
    expect(wrapToggle().getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".whitespace-pre-wrap")).toBeTruthy();
    unmount();

    const opted = render(<DiffsPage initial={{ wrap: "0" }} />);
    await screen.findByText("new line");
    expect(wrapToggle().getAttribute("aria-pressed")).toBe("false");
    expect(opted.container.querySelector(".whitespace-pre-wrap")).toBeNull();
  });

  test("honors the initial selection from the query string", async () => {
    render(<DiffsPage initial={{ scope: "STAGED", path: "src/staged.ts" }} />);
    const list = await fileList();
    expect(list.getByText("staged.ts")).toBeTruthy();
    expect(list.queryByText("app.ts")).toBeNull();
  });

  test("offers a commit picker in the commit scope", async () => {
    render(<DiffsPage initial={{ scope: "COMMIT" }} />);
    expect(await screen.findByText("Add search")).toBeTruthy();
    expect(screen.getByText("aaaaaaa")).toBeTruthy();
  });

  test("leaves the coverage strip blank until a report is chosen", async () => {
    const { container } = render(<DiffsPage />);
    await screen.findByText("new line");
    expect(container.querySelector("[data-coverage]")).toBeNull();
  });

  test("overlays the selected report's coverage on the diff", async () => {
    const { container } = render(
      <DiffsPage initial={{ coverageReportId: "report-1" }} />,
    );
    await screen.findByText("new line");
    const covered = await screen.findByText("keep");
    // The strip sits beside the line it describes, in the same grid row.
    expect(
      container.querySelectorAll('[data-coverage="covered"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-coverage="uncovered"]'),
    ).toHaveLength(1);
    expect(covered).toBeTruthy();
    // A deleted line has no line number in the new revision, so it stays blank.
    expect(container.querySelectorAll("[data-coverage]")).toHaveLength(2);
  });

  test("joins the report's file coverage into the sidebar", async () => {
    render(<DiffsPage initial={{ coverageReportId: "report-1" }} />);
    await fileList();
    // The list renders as soon as the diff lands; coverage joins in afterwards.
    await waitFor(async () => {
      const row = (await fileList()).getByText("app.ts").closest("button")!;
      expect(row.textContent).toContain("AppCore");
      expect(row.textContent).toContain("50%");
    });
    // A file the report never measured stays unlabelled.
    expect(
      (await fileList()).getByText("zebra.ts").closest("button")!.textContent,
    ).not.toContain("%");
  });

  test("trades the change counts for coverage rings under the coverage sort", async () => {
    render(<DiffsPage initial={{ coverageReportId: "report-1" }} />);
    const row = async () =>
      (await fileList()).getByText("app.ts").closest("button")!;
    await waitFor(async () =>
      expect((await row()).textContent).toContain("50%"),
    );
    expect((await row()).querySelector("[data-coverage-indicator]")).toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Sort files by" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "Coverage" }));

    const sorted = await row();
    expect(sorted.querySelector("[data-coverage-indicator]")).toBeTruthy();
    expect(sorted.textContent).toContain("50%");
    // The change type and its line counts give way to the ring.
    expect(sorted.textContent).not.toContain("+1");
    expect(sorted.textContent).not.toContain("M");
    expect((await fileRows())[0]).toContain("app.ts");

    fireEvent.click(screen.getByRole("button", { name: "Sort ascending" }));
    expect((await fileRows())[0]).toContain("app.ts");
  });

  test("uses the commit diff's truncation flag", async () => {
    commitDiff = {
      ...commitDiff,
      files: [
        {
          path: "src/commit.ts",
          previousPath: null,
          changeType: "M",
          additions: 2,
          deletions: 1,
          binary: false,
          image: false,
        },
      ],
      truncated: true,
    };

    render(
      <DiffsPage initial={{ scope: "COMMIT", commitSha: "aaaaaaa1111" }} />,
    );

    expect(await screen.findByText(/list truncated/)).toBeTruthy();
    expect((await fileList()).getByText("commit.ts")).toBeTruthy();
  });

  test("offers only ready reports in the picker", async () => {
    render(<DiffsPage />);
    await fileList();
    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Coverage report" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(
      await screen.findByRole("option", { name: /82% overall/ }),
    ).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  test("selecting a report from the picker paints the gutter", async () => {
    const { container } = render(<DiffsPage />);
    await screen.findByText("new line");
    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Coverage report" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByRole("option", { name: /82% overall/ }));
    await screen.findByText("new line");
    expect(container.querySelector('[data-coverage="uncovered"]')).toBeTruthy();
  });

  test("flags a report measured at a different revision", async () => {
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query DiffWorktrees")) return overview as never;
      if (operation.includes("query DiffCoverageReports")) {
        return {
          worktreeCoverageReports: [
            {
              ...coverageReports.worktreeCoverageReports[0],
              build: {
                id: "build-1",
                snapshot: { worktree: { headSha: "0000000" } },
              },
            },
          ],
        } as never;
      }
      if (operation.includes("query DiffCoverageReport"))
        return coverageReport as never;
      if (operation.includes("mutation DiffWorktreeDetail"))
        return detail as never;
      throw new Error(`unexpected operation: ${operation.slice(0, 40)}`);
    });
    render(<DiffsPage initial={{ coverageReportId: "report-1" }} />);
    expect(
      await screen.findByText("Measured at a different revision."),
    ).toBeTruthy();
  });

  test("flags changed working-tree contents even when HEAD has not moved", async () => {
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query DiffWorktrees")) return overview as never;
      if (operation.includes("query DiffCoverageReports")) {
        return {
          worktreeCoverageReports: [
            {
              ...coverageReports.worktreeCoverageReports[0],
              build: {
                id: "build-1",
                snapshot: {
                  worktree: {
                    headSha: "abc1234",
                    codeStateHash: "state-before-edit",
                  },
                },
              },
            },
          ],
        } as never;
      }
      if (operation.includes("query DiffCoverageReport"))
        return coverageReport as never;
      if (operation.includes("mutation DiffWorktreeDetail"))
        return detail as never;
      if (operation.includes("mutation InspectWorktreeDiff"))
        return { inspectWorktreeDiff: commitDiff } as never;
      throw new Error(`unexpected operation: ${operation.slice(0, 40)}`);
    });

    render(
      <DiffsPage initial={{ scope: "STAGED", coverageReportId: "report-1" }} />,
    );
    expect(
      await screen.findByText("Measured at a different revision."),
    ).toBeTruthy();
  });

  test("compares commit coverage with the selected commit instead of HEAD", async () => {
    render(
      <DiffsPage
        initial={{
          scope: "COMMIT",
          commitSha: "aaaaaaa1111",
          coverageReportId: "report-1",
        }}
      />,
    );

    expect(
      await screen.findByText("Measured at a different revision."),
    ).toBeTruthy();
  });

  test("discards late detail responses after switching worktrees", async () => {
    const firstWorktree = overview.worktreeOverview.agents[0]!.codebases[0]!;
    const secondWorktree = {
      ...firstWorktree.worktrees[0]!,
      id: "w2",
      branch: "feature/other",
      relativePath: "trees/other",
      folder: "/repos/web-other",
      codeStateHash: "state-other",
    };
    const switchingOverview = {
      worktreeOverview: {
        agents: [
          {
            codebases: [
              {
                ...firstWorktree,
                worktrees: [...firstWorktree.worktrees, secondWorktree],
              },
            ],
          },
        ],
      },
    };
    let resolveStale!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    const staleRequest = new Promise<unknown>((resolve) => {
      resolveStale = resolve;
    });
    const secondRequest = new Promise<unknown>((resolve) => {
      resolveSecond = resolve;
    });
    let firstDetailRequests = 0;
    request.mockImplementation((query, variables) => {
      const operation = String(query);
      if (operation.includes("query DiffWorktrees")) {
        return Promise.resolve(switchingOverview) as never;
      }
      if (operation.includes("query DiffCoverageReports")) {
        return Promise.resolve({ worktreeCoverageReports: [] }) as never;
      }
      if (operation.includes("mutation DiffWorktreeDetail")) {
        const id = (variables as { id?: string } | undefined)?.id;
        if (id === "w1") {
          firstDetailRequests += 1;
          return (
            firstDetailRequests === 1 ? Promise.resolve(detail) : staleRequest
          ) as never;
        }
        if (id === "w2") return secondRequest as never;
      }
      if (operation.includes("mutation InspectWorktreeDiff")) {
        return Promise.resolve({ inspectWorktreeDiff: commitDiff }) as never;
      }
      return Promise.reject(new Error(`unexpected operation: ${operation}`));
    });

    render(<DiffsPage />);
    expect((await fileList()).getByText("app.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(firstDetailRequests).toBe(2));

    fireEvent.click(
      screen.getByRole("combobox", { name: "Select a worktree" }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /feature\/other/ }),
    );
    await waitFor(() => expect(screen.queryByText("app.ts")).toBeNull());

    resolveStale(detail);
    await Promise.resolve();
    expect(screen.queryByText("app.ts")).toBeNull();

    resolveSecond({
      inspectWorktree: {
        ...detail.inspectWorktree,
        branchChanges: [
          {
            path: "src/second.ts",
            previousPath: null,
            changeType: "A",
            additions: 1,
            deletions: 0,
            binary: false,
            image: false,
          },
        ],
      },
    });
    expect(await screen.findByText("second.ts")).toBeTruthy();
    expect(screen.queryByText("app.ts")).toBeNull();
  });

  test("surfaces a failed load", async () => {
    request.mockImplementation(async (query) => {
      if (String(query).includes("query DiffWorktrees"))
        return overview as never;
      throw new Error("Agent is offline");
    });
    render(<DiffsPage />);
    expect(await screen.findByText("Agent is offline")).toBeTruthy();
  });
});
