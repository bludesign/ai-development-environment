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
import { formatDateValue } from "@/lib/date-format";

import { BuildDetailPage } from "./build-detail-page";

const terminalWrite = vi.hoisted(() => vi.fn());
const terminalReset = vi.hoisted(() => vi.fn());

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon() {}
    open() {}
    write(value: string | Uint8Array, callback?: () => void) {
      terminalWrite(value);
      callback?.();
    }
    onScroll() {
      return { dispose: vi.fn() };
    }
    scrollToBottom() {}
    reset() {
      terminalReset();
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext() {
      return false;
    }
    findPrevious() {
      return false;
    }
    clearDecorations() {}
    onDidChangeResults() {
      return { dispose: vi.fn() };
    }
  },
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
  worktree: { id: "worktree-1", highlightColor: "blue" },
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
      advancedSettings: {
        packageResolution: "SKIP_UPDATES",
        codeCoverage: true,
        parseTestResults: false,
        onlyTesting: ["AppTests/LoginTests"],
        buildSettingOverrides: { SWIFT_VERSION: "6.0" },
      },
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

function buildLogChunk(index: number, output = `output-${index}\r\n`) {
  const data = Buffer.from(output);
  return {
    id: `log-${String(index).padStart(5, "0")}`,
    scope: "BUILD",
    scopeId: "build-1",
    sequence: index,
    phase: "XCODEBUILD",
    stream: "STDOUT",
    dataBase64: data.toString("base64"),
    byteLength: data.byteLength,
    createdAt: new Date(Date.parse(now) + index).toISOString(),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  writeText.mockReset();
  terminalWrite.mockReset();
  terminalReset.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  nextLog = null;
  subscriptions.mockReturnValue({
    subscribe: vi.fn((operation, sink) => {
      if (String(operation.query).includes("subscription BuildLogChunkAdded")) {
        nextLog = (log) =>
          sink.next({ data: { buildLogChunkAdded: log } } as never);
      }
      return vi.fn();
    }),
  } as never);
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query BuildDetail")) {
      return { build } as never;
    }
    if (operation.includes("query BuildLogChunks")) {
      return {
        buildLogChunks: [
          {
            id: "log-1",
            scope: "BUILD",
            scopeId: "build-1",
            sequence: 0,
            phase: "XCODEBUILD",
            stream: "STDOUT",
            dataBase64: Buffer.from("Compile Swift sources\r\n").toString(
              "base64",
            ),
            byteLength: 23,
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
    if (operation.includes("query BuildRunAgents")) {
      return {
        buildRunAgents: [
          {
            agent: {
              id: "agent-1",
              name: "Build Mac",
              hostname: "build.local",
              osVersion: "macOS 26.0",
              architecture: "arm64",
              connectionStatus: "ONLINE",
            },
            isBuildAgent: true,
            available: true,
            unavailableReason: null,
          },
        ],
      } as never;
    }
    if (operation.includes("query BuildSigningOptions")) {
      return {
        buildSigningOptions: {
          teams: [{ id: "TEAM123", name: "Example, LLC" }],
          identities: [
            {
              sha1: "A".repeat(40),
              name: "Apple Development: Example (TEAM123)",
              teamId: "TEAM123",
            },
            // Shares the team but is absent from the profile, so exporting with
            // it would fail. It must never be offered.
            {
              sha1: "B".repeat(40),
              name: "Developer ID Application: Example (TEAM123)",
              teamId: "TEAM123",
            },
          ],
          profiles: [
            {
              uuid: "profile-development",
              name: "match Development com.example.App",
              teamId: "TEAM123",
              teamName: "Example, LLC",
              bundleId: "com.example.App",
              type: "DEVELOPMENT",
              platforms: ["iOS"],
              expiresAt: "2027-07-06T00:51:24Z",
              expired: false,
              xcodeManaged: false,
              certificateSha1s: ["A".repeat(40)],
            },
          ],
          bundles: [
            {
              bundleId: "com.example.App",
              name: "Example",
              relativePath: "Products/Applications/Example.app",
              embeddedProfileUuid: "profile-development",
              embeddedProfileName: "match Development com.example.App",
            },
          ],
        },
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
  vi.unstubAllGlobals();
});

describe("BuildDetailPage", () => {
  test("links to the localized raw build output", async () => {
    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);

    const link = await screen.findByRole("link", { name: "View raw output" });
    expect(link.getAttribute("href")).toBe("/en/builds/build-1/output");
  });

  test("shows the build ID, downloads artifacts, and deletes the build", async () => {
    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);

    expect(await screen.findByText("Development")).toBeDefined();
    const summary = screen.getByTestId("build-summary");
    expect(summary.className).toContain("bg-blue-500/10");
    expect(summary.className).toContain("border-l-blue-500");
    expect(screen.getAllByText(/build-1/).length).toBeGreaterThan(0);
    expect(screen.getByText("Out of date")).toBeDefined();
    const downloads = screen.getAllByRole("link", { name: "Download" });
    expect(downloads[0]?.getAttribute("href")).toBe(
      "/api/public/builds/build-1/artifacts/app-artifact",
    );
    expect(screen.getByText("Runnable App")).toBeDefined();
    expect(screen.getByText("Raw Log")).toBeDefined();
    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.some(
          ([value]) =>
            value instanceof Uint8Array &&
            Buffer.from(value).toString("utf8") === "Compile Swift sources\r\n",
        ),
      ).toBe(true),
    );
    const logViewport = screen.getByRole("log", { name: "Logs" });
    const detailGrid =
      logViewport.closest('[data-slot="card"]')?.parentElement?.parentElement;
    expect(detailGrid?.className).toContain("min-w-0");
    expect(detailGrid?.firstElementChild?.className).toContain("min-w-0");
    const collapseLogs = screen.getByRole("button", {
      name: "Collapse logs",
    });
    expect(screen.getByRole("button", { name: "Fit terminal" })).toBeDefined();
    expect(
      screen.getByRole("searchbox", { name: "Search terminal" }),
    ).toBeDefined();
    expect(collapseLogs.getAttribute("data-size")).toBe("icon-sm");
    expect(collapseLogs.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapseLogs);
    expect(screen.queryByRole("log", { name: "Logs" })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Expand logs" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    const advancedSettingsCard = screen
      .getByText("Advanced settings")
      .closest<HTMLElement>('[data-slot="card"]');
    expect(advancedSettingsCard).not.toBeNull();
    const overviewCard = screen
      .getByText("Overview")
      .closest<HTMLElement>('[data-slot="card"]');
    const commandCard = screen
      .getByText("Command summary")
      .closest<HTMLElement>('[data-slot="card"]');
    expect(advancedSettingsCard!.parentElement).toBe(
      overviewCard!.parentElement,
    );
    expect(advancedSettingsCard!.parentElement).not.toBe(
      commandCard!.parentElement,
    );
    expect(
      within(advancedSettingsCard!).getByText("Skip Updates"),
    ).toBeDefined();
    expect(
      within(advancedSettingsCard!).getByText("AppTests/LoginTests"),
    ).toBeDefined();
    expect(
      within(advancedSettingsCard!).getByText('{"SWIFT_VERSION":"6.0"}'),
    ).toBeDefined();
    expect(within(advancedSettingsCard!).getByText("Enabled")).toBeDefined();
    expect(within(advancedSettingsCard!).getByText("Disabled")).toBeDefined();
    const runsCard = screen
      .getByText("Runs and exports")
      .closest<HTMLElement>('[data-slot="card"]');
    expect(runsCard).not.toBeNull();
    expect(within(runsCard!).getByText("Succeeded")).toBeDefined();
    expect(within(runsCard!).getByText("Failed")).toBeDefined();
    expect(
      within(runsCard!).getAllByText(
        formatDateValue(now, "short", { locale: "en" }),
      ).length,
    ).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RebuildBuild"),
        { id: "build-1", requestId: expect.any(String) },
      ),
    );
    expect(await screen.findByText("The rebuild was queued.")).toBeDefined();
    expect(
      screen
        .getAllByRole("link", { name: "View build" })
        .find((link) => link.getAttribute("href") === "/builds/build-rebuilt"),
    ).toBeDefined();

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

  test("shows target-agent download progress independently from upload progress", async () => {
    request.mockImplementation(async (query) => {
      if (String(query).includes("query BuildDetail")) {
        return {
          build: {
            ...build,
            deployments: [
              {
                ...build.deployments[0],
                status: "TRANSFERRING",
                targetAgent: {
                  id: "agent-target",
                  name: "Studio Mac",
                  hostname: "studio.local",
                  osVersion: "macOS 26.0",
                  architecture: "arm64",
                  connectionStatus: "ONLINE",
                },
                transfer: {
                  id: "transfer-1",
                  status: "DOWNLOADING",
                  uploadOffset: 100,
                  uploadLength: 100,
                  downloadOffset: 25,
                  checksum: "a".repeat(64),
                  error: null,
                  createdAt: now,
                  updatedAt: now,
                  finishedAt: null,
                },
              },
            ],
          },
        } as never;
      }
      if (String(query).includes("query BuildLogChunks")) {
        return { buildLogChunks: [] } as never;
      }
      throw new Error(`Unexpected operation: ${String(query)}`);
    });

    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);

    const card = (await screen.findByText("Runs and exports")).closest(
      '[data-slot="card"]',
    );
    expect(card?.textContent).toContain("Running on Studio Mac");
    expect(card?.textContent).toContain("Downloading");
    expect(card?.textContent).toContain("25%");
  });

  test("loads build output beyond the former 5000-event limit", async () => {
    request.mockImplementation(async (query, variables) => {
      const operation = String(query);
      if (operation.includes("query BuildDetail")) return { build } as never;
      if (operation.includes("query BuildLogChunks")) {
        const after = (variables as { after?: string | null }).after;
        const start = after ? Number(after.slice(4)) + 1 : 0;
        const count = Math.min(1_000, 5_001 - start);
        return {
          buildLogChunks: Array.from({ length: count }, (_, offset) =>
            buildLogChunk(start + offset),
          ),
        } as never;
      }
      throw new Error(`Unexpected request: ${operation}`);
    });

    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);

    await waitFor(
      () =>
        expect(
          terminalWrite.mock.calls.some(
            ([value]) =>
              value instanceof Uint8Array &&
              Buffer.from(value).toString("utf8") === "output-5000\r\n",
          ),
        ).toBe(true),
      { timeout: 5_000 },
    );
    expect(
      request.mock.calls.filter(([query]) =>
        String(query).includes("query BuildLogChunks"),
      ),
    ).toHaveLength(6);
  });

  test("buffers and deduplicates subscription output during history loading", async () => {
    const chunk = buildLogChunk(7, "buffered output\r\n");
    let resolveHistory: (value: {
      buildLogChunks: (typeof chunk)[];
    }) => void = () => undefined;
    const history = new Promise<{ buildLogChunks: (typeof chunk)[] }>(
      (resolve) => {
        resolveHistory = resolve;
      },
    );
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query BuildDetail")) return { build } as never;
      if (operation.includes("query BuildLogChunks")) return history as never;
      throw new Error(`Unexpected request: ${operation}`);
    });

    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);
    expect(await screen.findByText("Development")).toBeDefined();
    await waitFor(() => expect(nextLog).not.toBeNull());
    act(() => nextLog?.(chunk));
    await act(async () => resolveHistory({ buildLogChunks: [chunk] }));

    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) =>
            value instanceof Uint8Array &&
            Buffer.from(value).toString("utf8") === "buffered output\r\n",
        ),
      ).toHaveLength(1),
    );
  });

  test("orders split chunks with identical timestamps by sequence", async () => {
    const createdAt = "2026-07-25T12:00:00.000Z";
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query BuildDetail")) return { build } as never;
      if (operation.includes("query BuildLogChunks")) {
        return {
          buildLogChunks: [
            {
              ...buildLogChunk(1, "second"),
              id: "a-random-id",
              createdAt,
            },
            {
              ...buildLogChunk(0, "first"),
              id: "z-random-id",
              createdAt,
            },
          ],
        } as never;
      }
      throw new Error(`Unexpected request: ${operation}`);
    });

    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);

    await waitFor(() =>
      expect(
        terminalWrite.mock.calls
          .filter(([value]) => value instanceof Uint8Array)
          .map(([value]) => Buffer.from(value).toString("utf8")),
      ).toEqual(["first", "second"]),
    );
  });

  test("appends late log chunks without resetting visible output", async () => {
    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);
    expect(await screen.findByText("Development")).toBeDefined();
    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) => value instanceof Uint8Array,
        ),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(nextLog).not.toBeNull());

    act(() =>
      nextLog?.({
        ...buildLogChunk(-1, "late output\r\n"),
        id: "late-log",
        createdAt: new Date(Date.parse(now) - 1).toISOString(),
      }),
    );

    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.filter(
          ([value]) => value instanceof Uint8Array,
        ),
      ).toHaveLength(2),
    );
    expect(terminalReset).not.toHaveBeenCalled();
  });

  test("filters compact test results grouped by suite and file", async () => {
    request.mockImplementation(async (query) => {
      if (String(query).includes("query BuildLogChunks")) {
        return { buildLogChunks: [] } as never;
      }
      if (!String(query).includes("query BuildDetail")) {
        throw new Error(`Unexpected request: ${query}`);
      }
      return {
        build: {
          ...build,
          action: "TEST",
          reports: [
            {
              id: "test-report",
              kind: "TEST_RESULTS",
              source: "AUTOMATIC",
              status: "READY",
              summary: { total: 4, passed: 2, failed: 1, skipped: 1 },
              data: {
                devices: [{ deviceName: "iPhone 17 Pro", osVersion: "26.0" }],
                tests: [
                  {
                    identifier: "LoginTests/testValidLogin()",
                    name: "testValidLogin()",
                    bundle: "AppTests",
                    suite: "LoginTests",
                    file: "LoginTests.swift",
                    plan: "Unit Tests",
                    configuration: "Debug",
                    result: "Passed",
                    durationSeconds: 0.125,
                    tags: ["smoke"],
                    details: [],
                  },
                  {
                    identifier: "LoginTests/testInvalidLogin()",
                    name: "testInvalidLogin()",
                    bundle: "AppTests",
                    suite: "LoginTests",
                    file: "LoginTests.swift",
                    plan: "Unit Tests",
                    configuration: "Debug",
                    result: "Failed",
                    durationSeconds: 0.25,
                    tags: [],
                    details: ["Expected login error"],
                  },
                  {
                    identifier: "SettingsTests/testDefaults()",
                    name: "testDefaults()",
                    bundle: "AppTests",
                    suite: "SettingsTests",
                    file: "SettingsTests.swift",
                    plan: "Unit Tests",
                    configuration: "Debug",
                    result: "Passed",
                    durationSeconds: 0.05,
                    tags: [],
                    details: [],
                  },
                  {
                    identifier: "SettingsTests/testRemoteSettings()",
                    name: "testRemoteSettings()",
                    bundle: "AppTests",
                    suite: "SettingsTests",
                    file: "SettingsTests.swift",
                    plan: "Unit Tests",
                    configuration: "Debug",
                    result: "Skipped",
                    durationSeconds: 0,
                    tags: [],
                    details: [],
                  },
                ],
              },
              error: null,
              artifact: null,
              createdAt: now,
              updatedAt: now,
              finishedAt: now,
            },
          ],
          artifacts: [
            ...build.artifacts,
            {
              id: "result-bundle",
              kind: "RESULT_BUNDLE",
              relativePath: "result.xcresult",
              sizeBytes: 4096,
              checksum: null,
              metadata: { coverageAvailable: true },
              createdAt: now,
            },
          ],
        },
      } as never;
    });

    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);

    expect(
      await screen.findByRole("tablist", { name: "Test result filters" }),
    ).toBeDefined();
    expect(screen.getByRole("tab", { name: "All (4)" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Passed (2)" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Failed (1)" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Skipped (1)" })).toBeDefined();
    expect(screen.queryByText("testValidLogin()")).toBeNull();

    const suite = screen.getByRole("button", {
      name: "Expand test suite LoginTests",
    });
    expect(suite.className).toContain("py-1.5");
    expect(within(suite).getByText("1 of 2 passed (50%)")).toBeDefined();
    fireEvent.click(suite);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand test file LoginTests.swift",
      }),
    );
    const loginTable = screen.getByRole("table", {
      name: "LoginTests.swift",
    });
    expect(within(loginTable).getByText("testValidLogin()")).toBeDefined();
    expect(within(loginTable).getByText("testInvalidLogin()")).toBeDefined();
    expect(loginTable.querySelector("tbody td")?.className).toContain("py-1.5");
    expect(
      within(loginTable).getByText("Passed").closest('[data-slot="badge"]')
        ?.className,
    ).toContain("text-emerald-700");
    expect(
      within(loginTable)
        .getByText("Failed")
        .closest('[data-slot="badge"]')
        ?.getAttribute("data-variant"),
    ).toBe("destructive");

    fireEvent.click(screen.getByRole("tab", { name: "Failed (1)" }));
    expect(screen.queryByText("testValidLogin()")).toBeNull();
    expect(screen.getByText("testInvalidLogin()")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Skipped (1)" }));
    expect(screen.queryByText("LoginTests.swift")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand test suite SettingsTests",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand test file SettingsTests.swift",
      }),
    );
    const settingsTable = screen.getByRole("table", {
      name: "SettingsTests.swift",
    });
    expect(
      within(settingsTable).getByText("testRemoteSettings()"),
    ).toBeDefined();
    expect(
      within(settingsTable).getByText("Skipped").closest('[data-slot="badge"]')
        ?.className,
    ).toContain("text-amber-700");
  });

  test("polls while a build or deployment is still active", async () => {
    const interval = vi.spyOn(window, "setInterval");
    request.mockImplementation(async (query) => {
      if (String(query).includes("query BuildLogChunks")) {
        return { buildLogChunks: [] } as never;
      }
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
        } as never;
      }
      throw new Error(`Unexpected request: ${query}`);
    });

    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);
    expect(await screen.findByText("Development")).toBeDefined();
    await waitFor(() =>
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 2_000),
    );
    interval.mockRestore();
  });

  test("streams logs, runs a captured app on multiple destinations, and exports an archive after configuration deletion", async () => {
    render(<BuildDetailPage buildId="build-1" publicOrigin={null} />);

    expect(await screen.findByText("Development")).toBeDefined();
    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.some(
          ([value]) =>
            value instanceof Uint8Array &&
            Buffer.from(value).toString("utf8") === "Compile Swift sources\r\n",
        ),
      ).toBe(true),
    );
    act(() => {
      const output = Buffer.from("Link App\r\n");
      nextLog?.({
        id: "log-2",
        scope: "BUILD",
        scopeId: "build-1",
        sequence: 1,
        phase: "XCODEBUILD",
        stream: "STDOUT",
        dataBase64: output.toString("base64"),
        byteLength: output.byteLength,
        createdAt: now,
      });
    });
    await waitFor(() =>
      expect(
        terminalWrite.mock.calls.some(
          ([value]) =>
            value instanceof Uint8Array &&
            Buffer.from(value).toString("utf8") === "Link App\r\n",
        ),
      ).toBe(true),
    );

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
        {
          agentId: "agent-1",
          buildId: "build-1",
          requestId: expect.any(String),
        },
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
            targetAgentId: "agent-1",
          },
        },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Export archive" }));
    const dialog = await screen.findByRole("dialog");
    // The team is read from the agent and defaults to whichever one signed the
    // archive, so no selection is needed for the common case.
    await within(dialog).findByText("Example, LLC (TEAM123)");
    // Only certificates the chosen profile accepts may be offered; exporting
    // with any other one fails in xcodebuild.
    expect(within(dialog).queryByText(/Developer ID Application/)).toBeNull();
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
      {
        agentId: "agent-1",
        buildId: "build-1",
        requestId: expect.any(String),
      },
    );
  });
});
