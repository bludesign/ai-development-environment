import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { DiffsPage } from "./diffs-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

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

beforeEach(() => {
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query DiffWorktrees")) return overview as never;
    if (operation.includes("mutation DiffWorktreeDetail"))
      return detail as never;
    if (operation.includes("mutation InspectWorktreeDiff")) {
      return {
        inspectWorktreeDiff: {
          files: [],
          patch: PATCH,
          image: false,
          binary: false,
          truncated: false,
          beforeAvailable: true,
          afterAvailable: true,
        },
      } as never;
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

describe("DiffsPage", () => {
  test("defaults to the branch scope and lists its changed files", async () => {
    render(<DiffsPage />);
    const list = await fileList();
    expect(list.getByText("src/app.ts")).toBeTruthy();
    expect(list.getByText("src/zebra.ts")).toBeTruthy();
    // Staged-only files must not leak into the branch scope.
    expect(list.queryByText("src/staged.ts")).toBeNull();
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
    expect(list.getByText("src/staged.ts")).toBeTruthy();
    expect(list.queryByText("src/zebra.ts")).toBeNull();
  });

  test("filters the file list by the search box", async () => {
    render(<DiffsPage />);
    await fileList();
    fireEvent.change(screen.getByLabelText("Search files"), {
      target: { value: "zebra" },
    });
    const list = await fileList();
    expect(list.queryByText("src/app.ts")).toBeNull();
    expect(list.getByText("src/zebra.ts")).toBeTruthy();
  });

  test("reverses the file order when the sort direction toggles", async () => {
    render(<DiffsPage />);
    const paths = async () =>
      (await fileList())
        .getAllByRole("button")
        .map((button) => button.textContent ?? "");
    expect((await paths())[0]).toContain("src/app.ts");
    fireEvent.click(screen.getByRole("button", { name: "Sort ascending" }));
    expect((await paths())[0]).toContain("src/zebra.ts");
  });

  test("honors the initial selection from the query string", async () => {
    render(<DiffsPage initial={{ scope: "STAGED", path: "src/staged.ts" }} />);
    const list = await fileList();
    expect(list.getByText("src/staged.ts")).toBeTruthy();
    expect(list.queryByText("src/app.ts")).toBeNull();
  });

  test("offers a commit picker in the commit scope", async () => {
    render(<DiffsPage initial={{ scope: "COMMIT" }} />);
    expect(await screen.findByText("Add search")).toBeTruthy();
    expect(screen.getByText("aaaaaaa")).toBeTruthy();
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
