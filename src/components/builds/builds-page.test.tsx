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

import { BuildsPage } from "./builds-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const now = new Date().toISOString();
let buildStatus = "RUNNING";
let nextBuild: (() => void) | null = null;

beforeEach(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  buildStatus = "RUNNING";
  nextBuild = null;
  subscriptions.mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      nextBuild = () =>
        sink.next({ data: { buildsChanged: { id: "build-1" } } } as never);
      return vi.fn();
    }),
  } as never);
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query BuildsPage")) {
      return {
        builds: {
          items: [
            {
              id: "build-1",
              requestId: "request-1",
              jobId: "job-1",
              status: buildStatus,
              outOfDate: buildStatus === "SUCCEEDED",
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
                worktree: { branch: "feature/builds" },
              },
              commandSummary: "xcrun xcodebuild build",
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
                  metadata: {},
                  createdAt: now,
                },
              ],
              createdAt: now,
              startedAt: now,
              finishedAt: null,
              durationMs: null,
              updatedAt: now,
            },
          ],
          nextCursor: null,
        },
        buildScripts: [
          {
            id: "script-1",
            name: "Generate Sources",
            preBuildScript: "console.log('before')",
            postBuildScript: "console.log('after')",
            enabledByDefault: true,
            timeoutSeconds: 60,
            failureBehavior: "FAIL_BUILD",
            createdAt: now,
            updatedAt: now,
          },
        ],
      } as never;
    }
    if (operation.includes("mutation SaveBuildScript")) {
      return { saveBuildScript: { id: "script-1" } } as never;
    }
    if (operation.includes("mutation DeleteBuilds")) {
      return { deleteBuilds: 1 } as never;
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
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("BuildsPage", () => {
  test("updates running durations on the clock ticker", async () => {
    const startedAt = Date.parse(now);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const interval = vi.spyOn(window, "setInterval");

    render(<BuildsPage />);

    expect(await screen.findByText("Duration 0s")).toBeDefined();
    dateNow.mockReturnValue(startedAt + 65_000);
    const update = interval.mock.calls.find(
      ([, delay]) => delay === 1_000,
    )?.[0];
    expect(typeof update).toBe("function");
    act(() => (update as () => void)());
    expect(screen.getByText("Duration 1m 5s")).toBeDefined();
  });

  test("updates history from subscriptions and edits reusable scripts", async () => {
    render(<BuildsPage />);

    expect(await screen.findByText("Example App")).toBeDefined();
    expect(screen.getByText("Running")).toBeDefined();
    buildStatus = "SUCCEEDED";
    await act(async () => nextBuild?.());
    expect(await screen.findByText("Succeeded")).toBeDefined();
    expect(screen.getByText("Out of date")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: /Build Scripts/ }));
    expect(await screen.findByText("Generate Sources")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Pre-build JavaScript"), {
      target: { value: "console.log('updated')" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SaveBuildScript"),
        {
          input: {
            id: "script-1",
            name: "Generate Sources",
            preBuildScript: "console.log('updated')",
            postBuildScript: "console.log('after')",
            enabledByDefault: true,
            timeoutSeconds: 60,
            failureBehavior: "FAIL_BUILD",
          },
        },
      ),
    );
  });

  test("selects a complete day for deletion and shows hook context templates", async () => {
    render(<BuildsPage />);

    expect(await screen.findByRole("table")).toBeDefined();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Select all builds for/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected (1)" }),
    );
    const confirmation = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete builds" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DeleteBuilds"),
        { ids: ["build-1"] },
      ),
    );

    fireEvent.click(screen.getByRole("tab", { name: /Build Scripts/ }));
    fireEvent.click(screen.getByRole("button", { name: "New build script" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      (
        within(dialog).getByLabelText(
          "Pre-build JavaScript",
        ) as HTMLTextAreaElement
      ).value,
    ).toContain("buildId");
    expect(
      (
        within(dialog).getByLabelText(
          "Post-build JavaScript",
        ) as HTMLTextAreaElement
      ).value,
    ).toContain("buildFolder");
  });

  test("opens builds from the full row and runs a captured app without an artifacts column", async () => {
    buildStatus = "SUCCEEDED";
    render(<BuildsPage />);

    expect(
      await screen.findByRole("link", { name: "View build" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("columnheader", { name: "Artifacts" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RebuildBuild"),
        { id: "build-1", requestId: expect.any(String) },
      ),
    );

    const destinationTrigger = screen.getByRole("button", {
      name: /1 devices/,
    });
    fireEvent.pointerDown(destinationTrigger, { button: 0, ctrlKey: false });
    const destination = await screen.findByRole("menuitemcheckbox", {
      name: /iPad Pro/,
    });
    fireEvent.click(destination);
    expect(screen.getByRole("button", { name: /2 devices/ })).toBeDefined();
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
  });
});
