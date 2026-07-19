import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CoverageReportPage } from "./coverage-report-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CoverageReportPage", () => {
  test("preserves target/file rows and filters them by target or path", async () => {
    request.mockResolvedValue({
      build: {
        id: "build-1",
        snapshot: {
          configuration: { name: "Tests" },
          worktree: { folder: "/repo" },
        },
        reports: [
          {
            id: "report-1",
            kind: "CODE_COVERAGE",
            source: "MANUAL",
            status: "READY",
            summary: {
              coveredLines: 15,
              executableLines: 20,
              lineCoverage: 0.75,
              changedLineCoverage: 0.8,
            },
            data: {
              changedFiles: [
                {
                  path: "Sources/Changed.swift",
                  changedCoveredLines: 4,
                  changedExecutableLines: 5,
                  changedLineCoverage: 0.8,
                  changeType: "MODIFIED",
                },
                {
                  path: "Sources/New.swift",
                  changedCoveredLines: 1,
                  changedExecutableLines: 5,
                  changedLineCoverage: 0.2,
                  changeType: "ADDED",
                },
              ],
              files: [
                {
                  target: "App",
                  name: "Changed.swift",
                  path: "/repo/Sources/Changed.swift",
                  coveredLines: 8,
                  executableLines: 10,
                  lineCoverage: 0.8,
                },
                {
                  target: "AppTests",
                  name: "New.swift",
                  path: "/repo/Sources/New.swift",
                  coveredLines: 7,
                  executableLines: 10,
                  lineCoverage: 0.7,
                },
              ],
            },
            error: null,
            artifact: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          },
        ],
      },
    } as never);

    render(<CoverageReportPage buildId="build-1" />);
    const overallCard = (await screen.findByText("Overall coverage")).closest(
      '[data-slot="card"]',
    );
    const changedCoverageCard = screen
      .getByText("Changed coverage")
      .closest('[data-slot="card"]');
    expect(
      overallCard?.querySelector("[data-coverage-indicator]")?.className,
    ).toContain("size-7");
    expect(
      changedCoverageCard?.querySelector("[data-coverage-indicator]")
        ?.className,
    ).toContain("size-7");
    const changedTable = await screen.findByRole("table", {
      name: "Coverage of changed files",
    });
    expect(within(changedTable).getByText("Changed.swift")).toBeDefined();
    expect(
      within(changedTable).getByText("Sources/Changed.swift"),
    ).toBeDefined();
    expect(within(changedTable).queryByText("App")).toBeNull();
    expect(changedTable.querySelector("tbody td")?.className).toContain(
      "py-1.5",
    );
    const firstChangedRow = () =>
      within(changedTable).getAllByRole("row").slice(1)[0]!;
    fireEvent.click(
      within(changedTable).getByRole("button", {
        name: "Sort coverage files by File",
      }),
    );
    expect(
      within(firstChangedRow()).getByText("Sources/New.swift"),
    ).toBeDefined();
    fireEvent.click(
      within(changedTable).getByRole("button", {
        name: "Sort coverage files by Change",
      }),
    );
    expect(
      within(firstChangedRow()).getByText("Sources/New.swift"),
    ).toBeDefined();
    fireEvent.click(
      within(changedTable).getByRole("button", {
        name: "Sort coverage files by Covered lines",
      }),
    );
    expect(
      within(firstChangedRow()).getByText("Sources/Changed.swift"),
    ).toBeDefined();
    const changedSearch = screen.getByRole("textbox", {
      name: "Search changed files or paths",
    });
    fireEvent.change(changedSearch, { target: { value: "New.swift" } });
    expect(within(changedTable).queryByText("Changed.swift")).toBeNull();
    expect(within(changedTable).getByText("New.swift")).toBeDefined();
    fireEvent.change(changedSearch, { target: { value: "" } });
    fireEvent.click(
      within(changedTable).getByRole("button", {
        name: "Sort coverage files by Coverage",
      }),
    );
    expect(
      within(firstChangedRow()).getByText("Sources/Changed.swift"),
    ).toBeDefined();
    const expand = await screen.findByRole("button", {
      name: "Expand all coverage files",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("table", { name: "All coverage files" }),
    ).toBeNull();
    expect(
      screen.queryByRole("textbox", {
        name: "Search targets, files, or paths",
      }),
    ).toBeNull();

    fireEvent.click(expand);
    const allFilesTable = await screen.findByRole("table", {
      name: "All coverage files",
    });
    expect(within(allFilesTable).getByText("80%")).toBeDefined();
    expect(within(allFilesTable).getByText("70%")).toBeDefined();
    expect(
      within(allFilesTable).getByText("Sources/Changed.swift"),
    ).toBeDefined();
    expect(
      within(allFilesTable)
        .getByText("Sources/Changed.swift")
        .getAttribute("title"),
    ).toBe("/repo/Sources/Changed.swift");
    expect(
      within(allFilesTable).queryByText("/repo/Sources/Changed.swift"),
    ).toBeNull();
    expect(
      allFilesTable.querySelectorAll("[data-coverage-indicator]"),
    ).toHaveLength(2);
    expect(
      allFilesTable
        .querySelector<HTMLElement>("[data-coverage-indicator]")
        ?.style.background.includes("conic-gradient"),
    ).toBe(true);
    expect(allFilesTable.querySelector("tbody td")?.className).toContain(
      "py-1.5",
    );

    const firstDataRow = () =>
      within(allFilesTable).getAllByRole("row").slice(1)[0]!;
    const fileSort = within(allFilesTable).getByRole("button", {
      name: "Sort coverage files by File",
    });
    fireEvent.click(fileSort);
    expect(within(firstDataRow()).getByText("New.swift")).toBeDefined();

    fireEvent.click(
      within(allFilesTable).getByRole("button", {
        name: "Sort coverage files by Target",
      }),
    );
    expect(within(firstDataRow()).getByText("Changed.swift")).toBeDefined();

    fireEvent.click(
      within(allFilesTable).getByRole("button", {
        name: "Sort coverage files by Coverage",
      }),
    );
    expect(within(firstDataRow()).getByText("Changed.swift")).toBeDefined();

    fireEvent.click(
      within(allFilesTable).getByRole("button", {
        name: "Sort coverage files by Uncovered lines",
      }),
    );
    expect(within(firstDataRow()).getByText("New.swift")).toBeDefined();

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Search targets, files, or paths",
      }),
      { target: { value: "AppTests" } },
    );
    expect(within(allFilesTable).queryByText("80%")).toBeNull();
    expect(within(allFilesTable).getByText("70%")).toBeDefined();
  });
});
