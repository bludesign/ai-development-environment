import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CommandTargetDialog } from "./command-target-dialog";
import type { CommandDefinition } from "./types";

afterEach(cleanup);

describe("CommandTargetDialog", () => {
  test("offers worktrees from every selected repository", () => {
    const onSelect = vi.fn();
    const command = {
      id: "command-1",
      name: "Test",
      targetKind: "REPOSITORY_WORKTREE",
      targetRepositoryIds: ["repo-web", "repo-ios"],
    } as CommandDefinition;
    render(
      <CommandTargetDialog
        agents={[
          {
            id: "agent-1",
            name: "Studio",
            hostname: "studio.local",
            connectionStatus: "ONLINE",
            capabilities: ["command.run"],
          },
        ]}
        command={command}
        onOpenChange={vi.fn()}
        onSelect={onSelect}
        open
        worktrees={[
          {
            id: "worktree-web",
            folder: "/web",
            branch: "web-main",
            highlightColor: null,
            repositoryId: "repo-web",
            repositoryName: "web",
            agentId: "agent-1",
            agentName: "Studio",
          },
          {
            id: "worktree-ios",
            folder: "/ios",
            branch: "ios-main",
            highlightColor: null,
            repositoryId: "repo-ios",
            repositoryName: "ios",
            agentId: "agent-1",
            agentName: "Studio",
          },
          {
            id: "worktree-api",
            folder: "/api",
            branch: "api-main",
            highlightColor: null,
            repositoryId: "repo-api",
            repositoryName: "api",
            agentId: "agent-1",
            agentName: "Studio",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /web-main/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /ios-main/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /api-main/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /ios-main/ }));
    expect(onSelect).toHaveBeenCalledWith({ worktreeId: "worktree-ios" });
  });
});
