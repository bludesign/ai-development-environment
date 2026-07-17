import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    fireEvent.click(
      await screen.findByRole("button", { name: /compare and resolve/i }),
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
  });
});
