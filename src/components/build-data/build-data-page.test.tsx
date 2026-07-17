import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { BuildDataPage } from "./build-data-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const agent = {
  id: "agent-1",
  name: "Builder",
  hostname: "builder.local",
  version: "0.1.0",
  osVersion: "macOS",
  architecture: "arm64",
  capabilities: ["buildData.scan", "buildData.size", "buildData.delete"],
  baseRepoDirectory: "/Repos",
  derivedDataLocationMode: "DEFAULT",
  derivedDataPath: null,
  connectionStatus: "ONLINE",
  ipAddress: null,
  lastSeenAt: new Date().toISOString(),
  disconnectedAt: null,
  createdAt: new Date(0).toISOString(),
};

function collection(operation: "IDLE" | "SIZING" | "DELETING" = "IDLE") {
  return {
    id: "collection-1",
    status: "COMPLETED",
    createdAt: new Date(0).toISOString(),
    deadlineAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    progress: {
      eligibleCount: 1,
      finishedCount: 1,
      successfulCount: 1,
      agents: [
        {
          agent,
          status: "SUCCEEDED",
          jobId: "scan-1",
          error: null,
          warnings: [],
        },
      ],
    },
    entries: [
      {
        id: "entry-1",
        name: "App-hash",
        status: "READY",
        workspacePath: "/Repos/App/App.xcodeproj",
        worktreeId: "worktree-1",
        worktreePath: "App",
        sizeBytes: null,
        operation,
        error: null,
        agent,
      },
      {
        id: "entry-2",
        name: "Starting-hash",
        status: "PENDING",
        workspacePath: null,
        worktreeId: null,
        worktreePath: null,
        sizeBytes: null,
        operation: "IDLE",
        error: null,
        agent,
      },
    ],
  };
}

describe("BuildDataPage", () => {
  beforeEach(() => {
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("DerivedDataDeletionHistory")) {
        return {
          derivedDataDeletionHistory: { items: [], nextCursor: null },
        } as never;
      }
      if (operation.includes("calculateDerivedDataSizes")) {
        return { calculateDerivedDataSizes: collection("SIZING") } as never;
      }
      if (operation.includes("deleteDerivedDataEntries")) {
        return { deleteDerivedDataEntries: collection("DELETING") } as never;
      }
      if (operation.includes("refreshDerivedData")) {
        return { refreshDerivedData: collection() } as never;
      }
      if (operation.includes("query DerivedDataCollection")) {
        return { derivedDataCollection: collection() } as never;
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("scans on load, links matched worktrees, and calculates sizes on demand", async () => {
    render(<BuildDataPage />);

    expect(await screen.findByText("App-hash")).toBeDefined();
    expect(screen.getByRole("link", { name: "App" }).getAttribute("href")).toBe(
      "/worktrees/worktree-1",
    );
    expect(screen.getByText("Build starting")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Calculate sizes" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("calculateDerivedDataSizes"),
        ),
      ).toBe(true),
    );
  });

  test("requires confirmation before deleting a row", async () => {
    render(<BuildDataPage />);
    await screen.findByText("App-hash");

    fireEvent.click(screen.getByRole("button", { name: "Delete App-hash" }));
    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      request.mock.calls.some(([query]) =>
        String(query).includes("deleteDerivedDataEntries"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("deleteDerivedDataEntries"),
        ),
      ).toBe(true),
    );
  });
});
