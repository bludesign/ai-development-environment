import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { AppEditorDialog } from "./app-editor-dialog";
import type { AppRepository } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

function repository(
  id: string,
  name: string,
  agent: { id: string; name: string },
): AppRepository {
  return {
    id,
    canonicalOrigin: `github.com/openai/${id}`,
    displayOrigin: `github.com/openai/${id}`,
    name,
    description: "",
    codebases: [
      {
        id: `codebase-${id}`,
        folder: `/workspaces/${id}`,
        branch: "main",
        availability: "AVAILABLE",
        agent: {
          id: agent.id,
          name: agent.name,
          hostname: `${agent.id}.local`,
          connectionStatus: "ONLINE",
        },
      },
    ],
  };
}

const repositories = [
  repository("codex", "Codex", { id: "agent-1", name: "Studio Mac" }),
  repository("payments", "Payments", { id: "agent-2", name: "Laptop" }),
];

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("AppEditorDialog", () => {
  test("keeps password managers away from the name field", () => {
    render(
      <AppEditorDialog
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        open
        repositories={repositories}
      />,
    );
    const name = screen.getByLabelText("Name");
    expect(name.getAttribute("autocomplete")).toBe("off");
    expect(name.hasAttribute("data-1p-ignore")).toBe(true);
    expect(name.getAttribute("data-lpignore")).toBe("true");
  });

  test("limits the repository list to the selected agents", () => {
    render(
      <AppEditorDialog
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        open
        repositories={repositories}
      />,
    );
    expect(screen.getByLabelText(/Codex/)).toBeDefined();
    expect(screen.getByLabelText(/Payments/)).toBeDefined();

    fireEvent.click(screen.getByLabelText("Laptop"));
    expect(screen.queryByLabelText(/Codex/)).toBeNull();
    expect(screen.getByLabelText(/Payments/)).toBeDefined();

    fireEvent.click(screen.getByLabelText("Laptop"));
    expect(screen.getByLabelText(/Codex/)).toBeDefined();
  });

  test("restores and saves agent filters without changing assignments", async () => {
    const onSaved = vi.fn();
    request.mockResolvedValue({ updateApp: { id: "app-1" } } as never);
    render(
      <AppEditorDialog
        app={
          {
            id: "app-1",
            name: "Platform",
            description: "",
            agentIds: ["agent-2"],
            repositories: [repositories[0]!],
            counts: {
              repositories: 1,
              codebases: 1,
              worktrees: 0,
              plans: 0,
              sessions: 0,
              builds: 0,
            },
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          } as never
        }
        onOpenChange={vi.fn()}
        onSaved={onSaved}
        open
        repositories={repositories}
      />,
    );

    expect(screen.getByLabelText("Laptop").getAttribute("data-state")).toBe(
      "checked",
    );
    expect(screen.queryByLabelText(/Codex/)).toBeNull();
    expect(screen.getByText(/hidden by the agent filter/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Save app" }));
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(expect.any(String), {
        input: {
          id: "app-1",
          name: "Platform",
          description: "",
          agentIds: ["agent-2"],
          repositoryIds: ["codex"],
        },
      }),
    );
  });
});
