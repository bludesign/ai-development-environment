import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppBuildLauncher } from "./app-build-launcher";

const active = vi.hoisted(() => ({ activeAgentId: null as string | null }));
vi.mock("@/components/active-agent/active-agent-provider", () => ({
  useActiveAgent: () => active,
}));
vi.mock("@/components/builds/start-build-dialog", () => ({
  StartBuildButton: ({
    worktreeId,
    disabled,
  }: {
    worktreeId: string;
    disabled: boolean;
  }) => <button disabled={disabled}>Build {worktreeId}</button>,
}));
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneSubscriptions: () => ({ subscribe: () => () => {} }),
  onControlPlaneRecovery: () => () => {},
  controlPlaneRequest: async () => ({
    app: {
      repositories: [
        {
          id: "repo",
          name: "iOS repo",
          iosAppProject: { id: "project" },
          latestBuild: {
            id: "latest-across-agents",
            status: "FAILED",
            action: "BUILD",
            createdAt: "2026-01-01T00:00:00Z",
            configuration: null,
            snapshot: { configuration: { kind: "CUSTOM" } },
            outOfDate: false,
          },
        },
        { id: "web", name: "Web repo", iosAppProject: null },
      ],
    },
    worktreeOverview: {
      agents: ["A", "B"].map((id) => ({
        agent: {
          id,
          name: `Agent ${id}`,
          connectionStatus: "ONLINE",
          capabilities: ["ios.build.run"],
        },
        codebases: [
          {
            repository: { id: "repo" },
            codebase: { id: `codebase-${id}` },
            worktrees: [
              {
                id: `tree-${id}`,
                folder: `/full/${id}`,
                branch: `branch-${id}`,
                availability: "AVAILABLE",
              },
            ],
          },
        ],
      })),
    },
  }),
}));
afterEach(() => {
  cleanup();
  active.activeAgentId = null;
});
test("active agent filters only the picker while latest build stays repository-wide and cards remain without an eligible tree", async () => {
  const { rerender } = render(<AppBuildLauncher appId="app" />);
  expect(await screen.findByText("iOS repo")).toBeDefined();
  expect(screen.queryByText("Web repo")).toBeNull();
  expect(screen.getByRole("button", { name: "Build tree-A" })).toBeDefined();
  active.activeAgentId = "B";
  rerender(<AppBuildLauncher appId="app" />);
  expect(screen.getByRole("button", { name: "Build tree-B" })).toBeDefined();
  expect(
    within(screen.getByRole("combobox")).getByText(/Agent B/),
  ).toBeDefined();
  expect(
    screen.getByRole("link", { name: "View build" }).getAttribute("href"),
  ).toContain("latest-across-agents");
  expect(screen.getByText("Failed")).toBeDefined();
  active.activeAgentId = "missing";
  rerender(<AppBuildLauncher appId="app" />);
  expect(
    screen.getByRole("button", { name: "Build" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText("iOS repo")).toBeDefined();
  expect(screen.getByText("Custom")).toBeDefined();
});
