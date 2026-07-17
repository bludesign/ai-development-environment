import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { SkillSyncPage } from "./skill-sync-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const encoded = (value: string) => Buffer.from(value).toString("base64");

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const targetPackage = {
  name: "swift-review",
  description: "Review Swift code safely.",
  packageHash: "target-hash",
  files: [
    {
      path: "SKILL.md",
      contentsBase64: encoded(
        "---\nname: swift-review\ndescription: Review Swift code safely.\n---\n\nClient instructions",
      ),
      executable: false,
    },
    {
      path: "asset.bin",
      contentsBase64: encoded("\0client-binary"),
      executable: true,
    },
  ],
};

const databaseFiles = [
  {
    path: "SKILL.md",
    contentsBase64: encoded(
      "---\nname: swift-review\ndescription: Review Swift code safely.\n---\n\nDatabase instructions",
    ),
    executable: false,
  },
  {
    path: "notes.md",
    contentsBase64: encoded("Database supporting file"),
    executable: false,
  },
];

beforeEach(() => {
  subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
  request.mockImplementation(async (query) => {
    if (String(query).includes("ConflictDatabasePackage")) {
      return { skill: { files: databaseFiles } } as never;
    }
    return {
      skillSyncRun: {
        id: "run-1",
        kind: "ALL",
        status: "NEEDS_RESOLUTION",
        error: null,
        group: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        finishedAt: null,
        items: [
          {
            id: "item-1",
            direction: "CONFLICT",
            status: "BLOCKED",
            sourceHash: "database-hash",
            targetHash: "target-hash",
            resolution: null,
            candidatePackage: { package: targetPackage },
            error: null,
            skill: {
              id: "skill-1",
              name: "swift-review",
              description: "Review Swift code safely.",
            },
            installation: null,
            agent: { id: "agent-1", name: "Studio Mac" },
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ],
      },
      skillsOverview: { groups: [] },
    } as never;
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

describe("SkillSyncPage", () => {
  test("compares full packages and prepares a complete manual result", async () => {
    render(<SkillSyncPage runId="run-1" />);

    expect(
      (await screen.findByText("Needs Resolution")).getAttribute("data-slot"),
    ).toBe("badge");
    expect(screen.getByText("Conflict").getAttribute("data-slot")).toBe(
      "badge",
    );
    expect(screen.getByText("Blocked").getAttribute("data-slot")).toBe("badge");

    fireEvent.click(
      screen.getByRole("button", { name: /compare and resolve/i }),
    );

    expect(await screen.findByText(/Database instructions/)).toBeTruthy();
    expect(screen.getAllByText(/Client instructions/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("button", { name: "asset.bin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "notes.md" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /use edited version/i }),
    ).toBeTruthy();
    const uploadControl = screen.getByText("Add or replace package files");
    expect(uploadControl.getAttribute("data-size")).toBe("sm");
    expect(uploadControl.className).toContain("h-7");
    expect(screen.getByLabelText("File path").className).toContain("h-8");
    expect(screen.getByRole("button", { name: "Rename" }).className).toContain(
      "h-8",
    );
    expect(
      screen.getByRole("checkbox", { name: "Executable" }).closest("label")
        ?.className,
    ).toContain("h-8");
    expect(screen.getByRole("button", { name: "Remove" }).className).toContain(
      "h-8",
    );
  });

  test("offers to skip pending clients and advances the run", async () => {
    const pendingRun = {
      id: "run-1",
      kind: "ALL",
      status: "PREPARING",
      error: null,
      group: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      finishedAt: null,
      items: [
        {
          id: "scan-1",
          direction: "SCAN",
          status: "PENDING",
          sourceHash: null,
          targetHash: null,
          resolution: null,
          candidatePackage: null,
          error: null,
          skill: null,
          installation: null,
          agent: {
            id: "agent-1",
            name: "Offline Mac",
            connectionStatus: "OFFLINE",
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
    };
    request.mockImplementation(async (query) => {
      if (String(query).includes("SkipPendingSkillSync")) {
        return {
          skipPendingSkillSync: {
            ...pendingRun,
            status: "READY",
            items: [{ ...pendingRun.items[0], status: "SKIPPED" }],
          },
        } as never;
      }
      return {
        skillSyncRun: pendingRun,
        skillsOverview: { groups: [] },
      } as never;
    });

    render(<SkillSyncPage runId="run-1" />);
    expect(await screen.findByText("Agent sync status")).toBeTruthy();
    expect(screen.getByText("Offline").getAttribute("data-slot")).toBe("badge");
    expect(screen.getByText("Scan").getAttribute("data-slot")).toBe("badge");
    expect(screen.getByText("Pending").getAttribute("data-slot")).toBe("badge");
    expect(screen.getByText("Proposed changes")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /skip pending clients/i }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("skipPendingSkillSync"),
        { runId: "run-1" },
      ),
    );
    expect(
      await screen.findByRole("row", {
        name: /Offline Mac Offline Scan Skipped/i,
      }),
    ).toBeTruthy();
  });

  test("can delete a discovered client skill instead of importing it", async () => {
    const importItem = {
      id: "import-1",
      direction: "IMPORT",
      status: "BLOCKED",
      sourceHash: null,
      targetHash: "target-hash",
      resolution: null,
      candidatePackage: {
        package: targetPackage,
        projectGroupRequired: true,
      },
      error: null,
      skill: null,
      installation: {
        id: "installation-1",
        skillName: "swift-review",
        rootPath: "/Users/test/.claude/skills",
        tracked: false,
        agent: {
          id: "agent-1",
          name: "Studio Mac",
          connectionStatus: "ONLINE",
        },
      },
      agent: {
        id: "agent-1",
        name: "Studio Mac",
        connectionStatus: "ONLINE",
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const importRun = {
      id: "run-1",
      kind: "ALL",
      status: "NEEDS_RESOLUTION",
      error: null,
      group: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      finishedAt: null,
      items: [importItem],
    };
    request.mockImplementation(async (query) => {
      if (String(query).includes("ResolveSkillSyncItem")) {
        return {
          resolveSkillSyncItem: {
            ...importRun,
            status: "READY",
            items: [
              {
                ...importItem,
                direction: "DELETE_REDUNDANT",
                resolution: "DELETE",
                status: "READY",
              },
            ],
          },
        } as never;
      }
      return {
        skillSyncRun: importRun,
        skillsOverview: { groups: [{ id: "group-1", name: "Swift" }] },
      } as never;
    });

    render(<SkillSyncPage runId="run-1" />);

    const groupSelect = await screen.findByRole("combobox");
    expect(groupSelect.getAttribute("data-slot")).toBe("select-trigger");
    expect(groupSelect.getAttribute("data-size")).toBe("sm");
    expect(groupSelect.className).toContain("mb-1");

    fireEvent.pointerDown(groupSelect, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Swift" }));
    expect(groupSelect.textContent).toContain("Swift");

    fireEvent.pointerDown(groupSelect, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "Choose a skill group" }),
    );
    expect(groupSelect.textContent).toContain("Choose a skill group");

    fireEvent.click(
      screen.getByRole("button", { name: /delete client copy/i }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("resolveSkillSyncItem"),
        {
          input: {
            itemId: "import-1",
            resolution: "DELETE",
            groupId: null,
            package: null,
          },
        },
      ),
    );
    expect(
      await screen.findByRole("row", {
        name: /Delete Redundant.*Ready/i,
      }),
    ).toBeTruthy();
  });
});
