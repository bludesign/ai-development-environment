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

import { AgentsList } from "./agents-list";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const agent = {
  id: "agent-1",
  name: "Studio Mac",
  hostname: "studio.local",
  version: "0.1.0",
  osVersion: "macOS",
  architecture: "arm64",
  capabilities: ["codebase.browse"],
  baseRepoDirectory: null,
  connectionStatus: "ONLINE" as const,
  ipAddress: null,
  lastSeenAt: new Date().toISOString(),
  disconnectedAt: null,
  createdAt: new Date(0).toISOString(),
};

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("AgentsList", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (operation.includes("query Agents"))
        return { agents: [agent] } as never;
      if (operation.includes("mutation BrowseAgentDirectory")) {
        return {
          browseAgentDirectory: {
            path: "/Users/test/Repositories",
            parentPath: "/Users/test",
            homePath: "/Users/test",
            entries: [],
            truncated: false,
          },
        } as never;
      }
      if (operation.includes("mutation UpdateAgentBaseRepoDirectory")) {
        return {
          updateAgentBaseRepoDirectory: {
            ...agent,
            baseRepoDirectory: "/Users/test/Repositories",
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("browses and saves an agent base repository directory", async () => {
    render(<AgentsList />);
    await screen.findByText("Studio Mac");
    fireEvent.click(
      screen.getByRole("button", { name: "Repository directories" }),
    );
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Agent" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const options = await screen.findAllByText("Studio Mac · studio.local");
    fireEvent.click(
      options.find((element) => element.tagName === "SPAN") ?? options[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse home folder" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Use this directory" }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation UpdateAgentBaseRepoDirectory"),
        {
          agentId: "agent-1",
          baseRepoDirectory: "/Users/test/Repositories",
        },
      ),
    );
    expect(await screen.findByTitle("/Users/test/Repositories")).toBeDefined();
  });
});
