import { describe, expect, test } from "vitest";

import {
  buildCoverageReportPayload,
  detectCoverageFormat,
  parseCoverageImportPayload,
  parseCoverageReport,
  parseIstanbulReport,
  parseLcovReport,
} from "./coverage";

const payload = {
  buildId: "build-1",
  codebaseId: "codebase-1",
  worktreeId: "worktree-1",
  folder: "/repos/app",
  reportPath: "coverage/lcov.info",
  format: "AUTO",
  baseBranch: "main",
};

describe("coverage import contract", () => {
  test("accepts a worktree-relative report path", () => {
    expect(parseCoverageImportPayload(payload)).toMatchObject({
      reportPath: "coverage/lcov.info",
      format: "AUTO",
      baseBranch: "main",
    });
    expect(
      parseCoverageImportPayload({ ...payload, baseBranch: null }),
    ).toMatchObject({ baseBranch: null });
  });

  test("rejects report paths that leave the worktree", () => {
    expect(() =>
      parseCoverageImportPayload({ ...payload, reportPath: "/etc/passwd" }),
    ).toThrow("inside the worktree");
    expect(() =>
      parseCoverageImportPayload({
        ...payload,
        reportPath: "../other/lcov.info",
      }),
    ).toThrow("inside the worktree");
  });

  test("rejects an unknown format", () => {
    expect(() =>
      parseCoverageImportPayload({ ...payload, format: "COBERTURA" }),
    ).toThrow("AUTO, LCOV, or ISTANBUL");
  });
});

describe("coverage report parsing", () => {
  const lcov = [
    "TN:",
    "SF:/repos/app/src/one.ts",
    "DA:1,4",
    "DA:2,0",
    "DA:2,3",
    "DA:5,0",
    "LF:3",
    "LH:2",
    "end_of_record",
    "SF:src/two.ts",
    "DA:10,0",
    "end_of_record",
    "",
  ].join("\n");

  test("reads line hits out of LCOV", () => {
    expect(parseLcovReport(lcov)).toEqual([
      {
        path: "/repos/app/src/one.ts",
        coveredLineNumbers: [1, 2],
        uncoveredLineNumbers: [5],
      },
      {
        path: "src/two.ts",
        coveredLineNumbers: [],
        uncoveredLineNumbers: [10],
      },
    ]);
  });

  test("reads statement hits out of an Istanbul report", () => {
    const istanbul = JSON.stringify({
      "/repos/app/src/one.ts": {
        path: "/repos/app/src/one.ts",
        statementMap: {
          "0": { start: { line: 1 }, end: { line: 1 } },
          "1": { start: { line: 2 }, end: { line: 2 } },
          "2": { start: { line: 2 }, end: { line: 4 } },
        },
        s: { "0": 2, "1": 0, "2": 7 },
      },
    });
    expect(parseIstanbulReport(istanbul)).toEqual([
      {
        path: "/repos/app/src/one.ts",
        coveredLineNumbers: [1, 2],
        uncoveredLineNumbers: [],
      },
    ]);
  });

  test("detects the format when the step leaves it on AUTO", () => {
    expect(detectCoverageFormat(lcov)).toBe("LCOV");
    expect(detectCoverageFormat('\n{"a":{}}')).toBe("ISTANBUL");
    expect(parseCoverageReport(lcov, "AUTO")).toHaveLength(2);
  });
});

describe("coverage report assembly", () => {
  const files = [
    {
      path: "/repos/app/src/one.ts",
      coveredLineNumbers: [1, 2, 3],
      uncoveredLineNumbers: [4],
    },
    {
      path: "two.ts",
      coveredLineNumbers: [1],
      uncoveredLineNumbers: [2, 3],
    },
  ];

  test("summarizes files and the lines the branch changed", () => {
    const report = buildCoverageReportPayload({
      files,
      folder: "/repos/app",
      changes: [
        { path: "src/one.ts", changeType: "M", lines: [2, 3, 4] },
        { path: "src/added.ts", changeType: "A", lines: [1, 2] },
      ],
    });
    expect(report.summary).toMatchObject({
      coveredLines: 4,
      executableLines: 7,
      lineCoverage: 4 / 7,
      fileCount: 2,
      // "src" for the nested file, "" for the one at the worktree root.
      targetCount: 2,
      changedCoveredLines: 2,
      changedExecutableLines: 3,
    });
    expect(report.data.files).toEqual([
      {
        target: "src",
        name: "one.ts",
        path: "/repos/app/src/one.ts",
        coveredLines: 3,
        executableLines: 4,
        lineCoverage: 0.75,
      },
      {
        target: "",
        name: "two.ts",
        path: "/repos/app/two.ts",
        coveredLines: 1,
        executableLines: 3,
        lineCoverage: 1 / 3,
      },
    ]);
  });

  test("keeps changed files the report never measured", () => {
    const report = buildCoverageReportPayload({
      files,
      folder: "/repos/app",
      changes: [{ path: "src/added.ts", changeType: "A", lines: [1, 2] }],
    });
    expect(report.data.changedFiles).toEqual([
      {
        path: "src/added.ts",
        changeType: "A",
        changedCoveredLines: 0,
        changedExecutableLines: 0,
        changedLineCoverage: null,
        coveredLineNumbers: [],
        uncoveredLineNumbers: [],
      },
    ]);
    expect(report.summary.changedLineCoverage).toBeNull();
  });

  test("drops report entries from outside the worktree", () => {
    const report = buildCoverageReportPayload({
      files: [
        {
          path: "/elsewhere/vendor.ts",
          coveredLineNumbers: [1],
          uncoveredLineNumbers: [],
        },
      ],
      folder: "/repos/app",
      changes: [],
    });
    expect(report.data.files).toEqual([]);
    expect(report.summary).toMatchObject({ fileCount: 0, lineCoverage: 0 });
  });
});
