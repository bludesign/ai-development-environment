import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        snapshot: { configuration: { name: "Tests" } },
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
            },
            data: {
              files: [
                {
                  target: "App",
                  name: "Shared.swift",
                  path: "/repo/Sources/Shared.swift",
                  coveredLines: 8,
                  executableLines: 10,
                  lineCoverage: 0.8,
                },
                {
                  target: "AppTests",
                  name: "Shared.swift",
                  path: "/repo/Sources/Shared.swift",
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
    const expand = await screen.findByRole("button", {
      name: "Expand all coverage files",
    });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("80%")).toBeNull();
    expect(
      screen.queryByRole("textbox", {
        name: "Search targets, files, or paths",
      }),
    ).toBeNull();

    fireEvent.click(expand);
    expect(await screen.findByText("80%")).toBeDefined();
    expect(screen.getByText("70%")).toBeDefined();

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Search targets, files, or paths",
      }),
      { target: { value: "AppTests" } },
    );
    expect(screen.queryByText("80%")).toBeNull();
    expect(screen.getByText("70%")).toBeDefined();
  });
});
