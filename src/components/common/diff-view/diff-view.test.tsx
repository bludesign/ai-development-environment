import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DiffView, type DiffViewLabels } from "./diff-view";
import { parseUnifiedPatch } from "./parse-patch";
import type { ParsedDiffFile } from "./types";

const labels: DiffViewLabels = {
  truncated: "Diff truncated",
  binary: "Binary file changed",
  empty: "No text changes",
  largeDiff: (count: number) => `This diff has ${count} lines.`,
  renderAnyway: "Render anyway",
  addComment: "Add a comment",
  noNewline: "No newline",
};

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x };
`;

/**
 * A short hunk numbered in the tens, then a wider one numbered in the
 * thousands — the case where each hunk sized its own columns.
 */
const TWO_HUNK_PATCH = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
@@ -4176,1 +4176,2 @@
 const alsoShort = 3;
+const theLongestLineInTheWholeFile = 4;
`;

function fileOf(patch: string): ParsedDiffFile {
  const [file] = parseUnifiedPatch(patch);
  if (!file) throw new Error("patch did not parse");
  return file;
}

afterEach(cleanup);

describe("DiffView", () => {
  test("renders every line's content in unified mode", () => {
    render(
      <DiffView
        file={fileOf(PATCH)}
        labels={labels}
        mode="UNIFIED"
        wrap={false}
      />,
    );
    expect(screen.getByText("const y = 2;")).toBeTruthy();
    expect(screen.getByText("const y = 3;")).toBeTruthy();
    expect(screen.getByText("const z = 4;")).toBeTruthy();
  });

  test("shows the same content in split mode, with context on both sides", () => {
    const { container } = render(
      <DiffView
        file={fileOf(PATCH)}
        labels={labels}
        mode="SPLIT"
        wrap={false}
      />,
    );
    // Context lines occupy both sides, so they appear twice.
    expect(screen.getAllByText("const x = 1;")).toHaveLength(2);
    // Changed lines appear on exactly one side each.
    expect(screen.getAllByText("const y = 2;")).toHaveLength(1);
    expect(screen.getAllByText("const z = 4;")).toHaveLength(1);
    expect(
      container.querySelector(
        ".grid-cols-\\[auto_minmax\\(0\\,1fr\\)_auto_auto_minmax\\(0\\,1fr\\)\\]",
      ),
    ).toBeTruthy();
  });

  test("swaps whitespace handling and grid width when wrapping toggles", () => {
    const file = fileOf(PATCH);
    const { container, rerender } = render(
      <DiffView file={file} labels={labels} mode="UNIFIED" wrap={false} />,
    );
    expect(container.querySelector(".whitespace-pre")).toBeTruthy();
    expect(container.querySelector(".w-max")).toBeTruthy();

    rerender(<DiffView file={file} labels={labels} mode="UNIFIED" wrap />);
    expect(container.querySelector(".whitespace-pre-wrap")).toBeTruthy();
    expect(container.querySelector(".w-max")).toBeNull();
  });

  test("reserves the file's widest line in every hunk when not wrapping", () => {
    const file = fileOf(TWO_HUNK_PATCH);
    // The second hunk holds the widest line; the first is far shorter.
    expect(file.maxLineWidth).toBe(39);
    const sized = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLElement>(".h-0")]
        .map((cell) => cell.style.minWidth)
        .filter(Boolean);

    const { container, rerender } = render(
      <DiffView file={file} labels={labels} mode="SPLIT" wrap={false} />,
    );
    // Two hunks, each reserving the same width in both of its content columns.
    expect(sized(container)).toEqual(Array(4).fill("calc(39.39ch + 1rem)"));

    // Unified mode has one content column per hunk, and its cells carry a
    // leading +/-/space marker the reserved width has to account for.
    rerender(
      <DiffView file={file} labels={labels} mode="UNIFIED" wrap={false} />,
    );
    expect(sized(container)).toEqual(Array(2).fill("calc(40.4ch + 1rem)"));

    // Wrapped columns are already the container's width, so nothing to reserve.
    rerender(<DiffView file={file} labels={labels} mode="SPLIT" wrap />);
    expect(sized(container)).toEqual([]);
  });

  test("sizes every gutter from the file's widest line number", () => {
    const file = fileOf(TWO_HUNK_PATCH);
    const { container } = render(
      <DiffView file={file} labels={labels} mode="SPLIT" wrap={false} />,
    );
    const gutters = [
      ...container.querySelectorAll<HTMLElement>(".tabular-nums"),
    ].map((cell) => cell.style.minWidth);
    expect(gutters.length).toBeGreaterThan(0);
    // Four digits everywhere, including the hunk whose lines are numbered 1-3.
    expect(new Set(gutters)).toEqual(new Set(["calc(4.04ch + 1rem)"]));
  });

  test("marks coverage state per line and skips deleted lines", () => {
    const { container } = render(
      <DiffView
        coverage={(line) => (line === 2 ? "covered" : "uncovered")}
        file={fileOf(PATCH)}
        labels={labels}
        mode="UNIFIED"
        wrap={false}
      />,
    );
    const covered = container.querySelectorAll('[data-coverage="covered"]');
    const uncovered = container.querySelectorAll('[data-coverage="uncovered"]');
    expect(covered).toHaveLength(1);
    // Four of the five lines have a new-revision line number; one is a deletion.
    expect(uncovered).toHaveLength(3);
  });

  test("dims coverage when the report is stale", () => {
    const { container } = render(
      <DiffView
        coverage={() => "covered"}
        coverageStale
        file={fileOf(PATCH)}
        labels={labels}
        mode="UNIFIED"
        wrap={false}
      />,
    );
    expect(
      container.querySelector('[data-coverage="covered"].opacity-40'),
    ).toBeTruthy();
  });

  test("reports the correct side when a line action fires", () => {
    const onLineAction = vi.fn();
    render(
      <DiffView
        file={fileOf(PATCH)}
        labels={labels}
        mode="UNIFIED"
        onLineAction={onLineAction}
        wrap={false}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Add a comment" });
    // One button per line, never two.
    expect(buttons).toHaveLength(5);
    fireEvent.click(buttons[1]!);
    expect(onLineAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "delete", oldLine: 2 }),
      "LEFT",
    );
  });

  test("disables the line action and explains why", () => {
    const onLineAction = vi.fn();
    render(
      <DiffView
        file={fileOf(PATCH)}
        labels={labels}
        lineActionDisabled
        lineActionDisabledReason="Push your commits first"
        mode="UNIFIED"
        onLineAction={onLineAction}
        wrap={false}
      />,
    );
    const button = screen.getAllByRole("button", { name: "Add a comment" })[0]!;
    expect(button.getAttribute("title")).toBe("Push your commits first");
    fireEvent.click(button);
    expect(onLineAction).not.toHaveBeenCalled();
  });

  test("anchors line extras beneath their line exactly once", () => {
    render(
      <DiffView
        file={fileOf(PATCH)}
        labels={labels}
        mode="UNIFIED"
        renderLineExtras={(line) =>
          line.newLine === 3 ? <span>thread here</span> : null
        }
        wrap={false}
      />,
    );
    expect(screen.getAllByText("thread here")).toHaveLength(1);
  });

  test("anchors extras once per context line in split mode", () => {
    render(
      <DiffView
        file={fileOf(PATCH)}
        labels={labels}
        mode="SPLIT"
        renderLineExtras={(line) =>
          line.kind === "context" ? <span>ctx thread</span> : null
        }
        wrap={false}
      />,
    );
    // Two context lines, one thread each — not one per side.
    expect(screen.getAllByText("ctx thread")).toHaveLength(2);
  });

  test("renders the no-newline marker", () => {
    render(
      <DiffView
        file={fileOf(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
`)}
        labels={labels}
        mode="UNIFIED"
        wrap={false}
      />,
    );
    expect(screen.getByText("No newline")).toBeTruthy();
  });

  test("shows the binary placeholder instead of hunks", () => {
    render(
      <DiffView
        file={fileOf(`diff --git a/logo.png b/logo.png
index 111..222 100644
Binary files a/logo.png and b/logo.png differ
`)}
        labels={labels}
        mode="UNIFIED"
        wrap={false}
      />,
    );
    expect(screen.getByText("Binary file changed")).toBeTruthy();
  });

  test("holds back a very large diff until asked", () => {
    const file = fileOf(PATCH);
    const huge: ParsedDiffFile = { ...file, lineCount: 12_431 };
    render(
      <DiffView file={huge} labels={labels} mode="UNIFIED" wrap={false} />,
    );
    expect(screen.getByText("This diff has 12431 lines.")).toBeTruthy();
    expect(screen.queryByText("const y = 3;")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Render anyway" }));
    expect(screen.getByText("const y = 3;")).toBeTruthy();
  });

  test("shows the truncation note when the backend capped the patch", () => {
    render(
      <DiffView
        file={fileOf(PATCH)}
        labels={labels}
        mode="UNIFIED"
        truncated
        wrap={false}
      />,
    );
    expect(screen.getByText("Diff truncated")).toBeTruthy();
  });
});
