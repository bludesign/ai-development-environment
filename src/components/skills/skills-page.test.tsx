import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { SkillsPage } from "./skills-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const agent = {
  id: "agent-1",
  name: "Studio Mac",
  hostname: "studio.local",
  connectionStatus: "ONLINE",
};

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("SkillsPage", () => {
  test("shows database skills and only configured enabled client tabs", async () => {
    request.mockResolvedValue({
      skillsOverview: {
        skills: [
          {
            id: "skill-1",
            name: "swift-review",
            description: "Review Swift code safely.",
            syncGlobally: false,
            packageHash: "hash-1",
            updatedAt: new Date(0).toISOString(),
            files: [{ id: "file-1", path: "SKILL.md" }],
            groups: [{ id: "group-1", name: "Swift" }],
          },
        ],
        groups: [{ id: "group-1", name: "Swift" }],
        observations: [
          {
            tool: "CURSOR",
            configured: true,
            homePath: "/Users/test",
            checkedAt: new Date().toISOString(),
            agent,
          },
          {
            tool: "CLAUDE",
            configured: false,
            homePath: "/Users/test",
            checkedAt: new Date().toISOString(),
            agent,
          },
        ],
        installations: [],
        settings: {
          autoSyncProjectGroups: false,
          cursorEnabled: true,
          githubCopilotEnabled: true,
          codexEnabled: true,
          claudeEnabled: true,
          openCodeEnabled: true,
          updatedAt: new Date().toISOString(),
        },
        repositories: [],
      },
    } as never);

    render(<SkillsPage />);

    expect(
      (await screen.findByRole("link", { name: "swift-review" })).getAttribute(
        "href",
      ),
    ).toBe("/skills/skill-1");
    expect(screen.getByRole("tab", { name: "Cursor" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Claude Code" })).toBeNull();
    const mobileSelector = screen.getByRole("combobox", {
      name: "Skill source",
    });
    expect(mobileSelector.closest(".sm\\:hidden")).toBeTruthy();
    expect(mobileSelector.querySelector("svg")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Cursor" }).querySelector("svg"),
    ).toBeTruthy();
    expect(screen.getByText("Database skills")).toBeTruthy();
    expect(screen.getByText("Swift")).toBeTruthy();
  });
});
