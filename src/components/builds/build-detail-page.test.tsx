import {
  act,
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

import { BuildDetailPage } from "./build-detail-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const now = new Date().toISOString();
let nextLog: ((log: Record<string, unknown>) => void) | null = null;
const writeText = vi.fn();

const build = {
  id: "build-1",
  requestId: "request-1",
  jobId: "job-1",
  status: "SUCCEEDED",
  outOfDate: true,
  action: "BUILD",
  destinationType: "SIMULATOR",
  destination: {
    type: "SIMULATOR",
    id: "SIM-1",
    name: "iPhone 17 Pro",
    platform: "iOS Simulator",
    osVersion: "26.0",
    state: "Booted",
  },
  snapshot: {
    repository: { name: "Example App" },
    worktree: {
      id: "worktree-1",
      branch: "feature/builds",
      folder: "/agent/repository",
      headSha: "abc123",
    },
    configuration: {
      id: "deleted-configuration",
      name: "Development",
      scheme: "App",
      buildConfiguration: "Debug",
    },
  },
  commandSummary: "xcrun xcodebuild -workspace App.xcworkspace build",
  artifactDirectory: "/agent/builds/build-1",
  errorCode: null,
  error: null,
  artifacts: [
    {
      id: "app-artifact",
      kind: "RUNNABLE_APP",
      relativePath: "products/App.app",
      sizeBytes: 1024,
      checksum: null,
      metadata: { bundleIdentifier: "com.example.app" },
      createdAt: now,
    },
    {
      id: "archive-artifact",
      kind: "ARCHIVE",
      relativePath: "archive.xcarchive",
      sizeBytes: 2048,
      checksum: null,
      metadata: {},
      createdAt: now,
    },
    {
      id: "raw-log-artifact",
      kind: "RAW_LOG",
      relativePath: "logs/raw.log",
      sizeBytes: 512,
      checksum: null,
      metadata: {},
      createdAt: now,
    },
  ],
  scriptExecutions: [],
  deployments: [
    {
      id: "deployment-complete",
      batchId: "batch-1",
      destination: {
        type: "SIMULATOR",
        id: "SIM-2",
        name: "iPad Pro",
        platform: "iOS Simulator",
        osVersion: "26.0",
        state: "Booted",
      },
      status: "SUCCEEDED",
      commandSummary: "install and launch",
      outputRelativePath: null,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    },
  ],
  exports: [
    {
      id: "export-complete",
      status: "FAILED",
      settings: {},
      commandSummary: "export archive",
      outputRelativePath: null,
      error: "Export failed",
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    },
  ],
  configuration: null,
  createdAt: now,
  startedAt: now,
  finishedAt: now,
  durationMs: 1000,
  updatedAt: now,
};

beforeEach(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  nextLog = null;
  subscriptions.mockReturnValue({
    subscribe: vi.fn((operation, sink) => {
      if (String(operation.query).includes("subscription BuildLogAdded")) {
        nextLog = (log) => sink.next({ data: { buildLogAdded: log } } as never);
      }
      return vi.fn();
    }),
  } as never);
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query BuildDetail")) {
      return {
        build,
        buildLogs: [
          {
            id: "log-1",
            scope: "BUILD",
            scopeId: "build-1",
            sequence: 0,
            phase: "XCODEBUILD",
            level: "INFO",
            stream: "STDOUT",
            message: "Compile Swift sources",
            createdAt: now,
          },
        ],
      } as never;
    }
    if (operation.includes("mutation BuildRunDestinations")) {
      return {
        inspectBuildRunDestinations: [
          {
            type: "SIMULATOR",
            id: "SIM-1",
            name: "iPhone 17 Pro",
            platform: "iOS Simulator",
            osVersion: "26.0",
            state: "Booted",
          },
          {
            type: "SIMULATOR",
            id: "SIM-2",
            name: "iPad Pro",
            platform: "iOS Simulator",
            osVersion: "26.0",
            state: "Shutdown",
          },
        ],
      } as never;
    }
    if (operation.includes("mutation RunCompletedBuild")) {
      return { runBuild: [] } as never;
    }
    if (operation.includes("mutation RebuildBuild")) {
      return {
        rebuildBuild: { id: "build-rebuilt", status: "QUEUED" },
      } as never;
    }
    if (operation.includes("mutation ExportArchive")) {
      return {
        exportBuildArchive: { id: "export-1", status: "QUEUED" },
      } as never;
    }
    if (operation.includes("mutation DeleteBuild")) {
      return { deleteBuilds: 1 } as never;
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BuildDetailPage", () => {
  test("shows the build ID, downloads artifacts, and deletes the build", async () => {
    render(<BuildDetailPage buildId="build-1" />);

    expect(await screen.findByText("Development")).toBeDefined();
    expect(screen.getAllByText(/build-1/).length).toBeGreaterThan(0);
    expect(screen.getByText("Out of date")).toBeDefined();
    const downloads = screen.getAllByRole("link", { name: "Download" });
    expect(downloads[0]?.getAttribute("href")).toBe(
      "/api/builds/build-1/artifacts/app-artifact",
    );
    expect(screen.getByText("Runnable App")).toBeDefined();
    expect(screen.getByText("Raw Log")).toBeDefined();
    const runsCard = screen
      .getByText("Runs and exports")
      .closest<HTMLElement>('[data-slot="card"]');
    expect(runsCard).not.toBeNull();
    expect(within(runsCard!).getByText("Succeeded")).toBeDefined();
    expect(within(runsCard!).getByText("Failed")).toBeDefined();
    expect(
      within(runsCard!).getAllByText(new Date(now).toLocaleString("en")).length,
    ).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RebuildBuild"),
        { id: "build-1", requestId: expect.any(String) },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete build" }));
    const confirmation = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete build" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DeleteBuild"),
        { ids: ["build-1"] },
      ),
    );
  });

  test("polls while a build or deployment is still active", async () => {
    const interval = vi.spyOn(window, "setInterval");
    request.mockImplementation(async (query) => {
      if (String(query).includes("query BuildDetail")) {
        return {
          build: {
            ...build,
            deployments: [
              {
                id: "deployment-1",
                batchId: "batch-1",
                destination: build.destination,
                status: "QUEUED",
                commandSummary: "open Simulator and install",
                outputRelativePath: null,
                error: null,
                createdAt: now,
                startedAt: null,
                finishedAt: null,
              },
            ],
          },
          buildLogs: [],
        } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<BuildDetailPage buildId="build-1" />);
    expect(await screen.findByText("Development")).toBeDefined();
    await waitFor(() =>
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 2_000),
    );
    interval.mockRestore();
  });

  test("streams logs, runs a captured app on multiple destinations, and exports an archive after configuration deletion", async () => {
    render(<BuildDetailPage buildId="build-1" />);

    expect(await screen.findByText("Development")).toBeDefined();
    expect(screen.getByText(/Compile Swift sources/)).toBeDefined();
    act(() => {
      nextLog?.({
        id: "log-2",
        scope: "BUILD",
        scopeId: "build-1",
        sequence: 1,
        phase: "XCODEBUILD",
        level: "INFO",
        stream: "STDOUT",
        message: "Link App",
        createdAt: now,
      });
    });
    expect(screen.getByText(/Link App/)).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Scroll logs to bottom" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Scroll logs to top" }));
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledTimes(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy command summary" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(build.commandSummary),
    );
    expect(
      screen.getByRole("button", { name: "Command summary copied" }),
    ).toBeDefined();

    const destinationTrigger = screen.getByRole("button", {
      name: /1 devices/,
    });
    fireEvent.pointerDown(destinationTrigger, { button: 0, ctrlKey: false });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation BuildRunDestinations"),
        { buildId: "build-1", requestId: expect.any(String) },
      ),
    );
    if (destinationTrigger.getAttribute("aria-expanded") !== "true") {
      fireEvent.pointerDown(destinationTrigger, { button: 0, ctrlKey: false });
    }
    expect(
      await screen.findByRole("menuitemcheckbox", { name: /iPad Pro/ }),
    ).toBeDefined();
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: /iPad Pro/ }),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RunCompletedBuild"),
        {
          input: {
            buildId: "build-1",
            destinations: [
              expect.objectContaining({ id: "SIM-1" }),
              expect.objectContaining({ id: "SIM-2" }),
            ],
            requestId: expect.any(String),
          },
        },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Export archive" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Development team"), {
      target: { value: "TEAM123" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Export archive" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation ExportArchive"),
        {
          input: expect.objectContaining({
            buildId: "build-1",
            requestId: expect.any(String),
            settings: expect.objectContaining({
              method: "DEBUGGING",
              signingStyle: "AUTOMATIC",
              teamId: "TEAM123",
            }),
          }),
        },
      ),
    );
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation BuildRunDestinations"),
      { buildId: "build-1", requestId: expect.any(String) },
    );
  });
});
