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

import { RepositoryDetailPage } from "./repository-detail-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

vi.mock("@/components/builds/ios-project-section", () => ({
  IosProjectSection: ({
    checkouts,
  }: {
    checkouts: Array<{ label: string }>;
  }) => <div>{checkouts.map((checkout) => checkout.label).join(" | ")}</div>,
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const agent = {
  id: "agent-1",
  name: "Studio Mac",
  hostname: "studio.local",
  capabilities: [],
  connectionStatus: "ONLINE",
};

const repository = {
  id: "repository-1",
  canonicalOrigin: "github.com/example/app",
  displayOrigin: "github.com/example/app",
  name: "App",
  description: "iOS app",
  jiraBranchRegex: null,
  keepBaseBranchUpToDate: true,
  skillGroups: [{ id: "group-1", name: "Mobile" }],
  codebases: [
    {
      id: "codebase-1",
      folder: "/Users/test/Repositories/App",
      availability: "AVAILABLE",
      agent,
    },
    {
      id: "codebase-2",
      folder: "/Users/test/Other/App",
      availability: "AVAILABLE",
      agent: { ...agent, id: "agent-2", name: "Laptop" },
    },
  ],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("RepositoryDetailPage", () => {
  beforeEach(() => {
    global.ResizeObserver = ResizeObserverMock;
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      if (String(query).includes("query RepositoryDetail")) {
        return {
          codebaseRepository: repository,
          skillsOverview: {
            groups: [
              { id: "group-1", name: "Mobile" },
              { id: "group-2", name: "Backend" },
            ],
          },
        } as never;
      }
      if (String(query).includes("mutation UpdateCodebaseRepository")) {
        return { updateCodebaseRepository: { id: "repository-1" } } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("edits shared repository settings and hosts iOS settings across agents", async () => {
    render(<RepositoryDetailPage repositoryId="repository-1" />);

    expect(await screen.findByText("Edit repository details")).toBeDefined();
    const checkbox = screen.getByRole("checkbox", {
      name: "Keep base branch up to date",
    });
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("mutation UpdateCodebaseRepository") &&
            (
              variables as {
                input?: { keepBaseBranchUpToDate?: boolean };
              }
            ).input?.keepBaseBranchUpToDate === false,
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("tab", { name: "iOS App" }));
    expect(
      await screen.findByText(
        "Studio Mac · /Users/test/Repositories/App | Laptop · /Users/test/Other/App",
      ),
    ).toBeDefined();
  });
});
