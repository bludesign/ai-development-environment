import { describe, expect, test } from "vitest";

import { pairHunkRows, parseUnifiedPatch } from "./parse-patch";

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x };
`;

describe("parseUnifiedPatch", () => {
  test("resolves old and new line numbers for every line", () => {
    const [file] = parseUnifiedPatch(MODIFIED);
    expect(file?.path).toBe("src/a.ts");
    expect(file?.changeType).toBe("M");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(
      file?.hunks[0]?.lines.map((line) => [
        line.kind,
        line.oldLine,
        line.newLine,
        line.content,
      ]),
    ).toEqual([
      ["context", 1, 1, "const x = 1;"],
      ["delete", 2, null, "const y = 2;"],
      ["add", null, 2, "const y = 3;"],
      ["add", null, 3, "const z = 4;"],
      ["context", 3, 4, "export { x };"],
    ]);
  });

  test("splits a multi-file patch and keeps each change type", () => {
    const patch = `${MODIFIED}diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,2 @@
-old
+new
 same
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-line one
diff --git a/src/fresh.ts b/src/fresh.ts
new file mode 100644
--- /dev/null
+++ b/src/fresh.ts
@@ -0,0 +1,1 @@
+hello
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
`;
    const files = parseUnifiedPatch(patch);
    expect(
      files.map((file) => [file.path, file.previousPath, file.changeType]),
    ).toEqual([
      ["src/a.ts", null, "M"],
      ["src/new.ts", "src/old.ts", "R"],
      ["src/gone.ts", null, "D"],
      ["src/fresh.ts", null, "A"],
      ["logo.png", null, "M"],
    ]);
    expect(files.at(-1)?.binary).toBe(true);
    expect(files.at(-1)?.hunks).toEqual([]);
  });

  test("keeps a deleted file's path when the new side is /dev/null", () => {
    const [file] = parseUnifiedPatch(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-only
`);
    expect(file?.path).toBe("gone.ts");
    expect(file?.previousPath).toBeNull();
    expect(file?.hunks[0]?.lines[0]?.oldLine).toBe(1);
    expect(file?.hunks[0]?.lines[0]?.newLine).toBeNull();
  });

  test("folds the no-newline marker onto the preceding line", () => {
    const [file] = parseUnifiedPatch(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.noNewline)).toEqual([false, true, true]);
    expect(lines[1]?.content).toBe("old");
  });

  test("measures the gap before each hunk", () => {
    const [file] = parseUnifiedPatch(`diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -20,3 +20,3 @@
 x
-y
+Y
 z
`);
    expect(file?.hunks.map((hunk) => hunk.gapBefore)).toEqual([0, 16]);
    expect(file?.hunks[1]?.header).toBe("@@ -20,3 +20,3 @@");
  });

  test("preserves carriage returns as line content", () => {
    const [file] = parseUnifiedPatch(
      "diff --git a/c.txt b/c.txt\n--- a/c.txt\n+++ b/c.txt\n@@ -1,1 +1,1 @@\r\n-old\r\n+new\r\n",
    );
    expect(file?.hunks[0]?.lines.map((line) => line.content)).toEqual([
      "old\r",
      "new\r",
    ]);
  });

  test("treats a bare empty line as empty context", () => {
    const [file] = parseUnifiedPatch(`diff --git a/d.txt b/d.txt
--- a/d.txt
+++ b/d.txt
@@ -1,2 +1,2 @@

-old
+new
`);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines[0]).toMatchObject({ kind: "context", content: "" });
    expect(lines[1]).toMatchObject({ kind: "delete", oldLine: 2 });
  });

  test("returns nothing for empty or unparseable input", () => {
    expect(parseUnifiedPatch("")).toEqual([]);
    expect(parseUnifiedPatch("   \n  ")).toEqual([]);
    expect(parseUnifiedPatch("not a patch at all")).toEqual([]);
  });

  test("reports the widest line number and total rendered rows", () => {
    const [file] = parseUnifiedPatch(MODIFIED);
    expect(file?.lineCount).toBe(5);
    expect(file?.maxLineNumber).toBe(4);
  });
});

describe("pairHunkRows", () => {
  test("zips replaced lines opposite their replacements", () => {
    const [file] = parseUnifiedPatch(MODIFIED);
    const rows = file?.hunks[0]?.rows ?? [];
    expect(
      rows.map((row) => [
        row.left?.content ?? null,
        row.right?.content ?? null,
      ]),
    ).toEqual([
      ["const x = 1;", "const x = 1;"],
      ["const y = 2;", "const y = 3;"],
      [null, "const z = 4;"],
      ["export { x };", "export { x };"],
    ]);
  });

  test("pads the shorter side when deletions outnumber additions", () => {
    const [file] = parseUnifiedPatch(`diff --git a/e.txt b/e.txt
--- a/e.txt
+++ b/e.txt
@@ -1,3 +1,1 @@
-one
-two
-three
+only
`);
    const rows = file?.hunks[0]?.rows ?? [];
    expect(
      rows.map((row) => [
        row.left?.content ?? null,
        row.right?.content ?? null,
      ]),
    ).toEqual([
      ["one", "only"],
      ["two", null],
      ["three", null],
    ]);
  });

  test("renders every unified line exactly once across the paired rows", () => {
    const [file] = parseUnifiedPatch(MODIFIED);
    const hunk = file?.hunks[0];
    const paired = new Set<string>();
    for (const row of hunk?.rows ?? []) {
      if (row.left) paired.add(row.left.key);
      if (row.right) paired.add(row.right.key);
    }
    expect(paired.size).toBe(hunk?.lines.length);
  });

  test("returns no rows for an empty hunk", () => {
    expect(pairHunkRows([])).toEqual([]);
  });
});
