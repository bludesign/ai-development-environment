import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CommandsPage } from "@/components/commands/commands-page";
import { RunsPage } from "@/components/runs/runs-page";
import { WorkflowsPage } from "@/components/workflows/workflows-page";
import { TooltipProvider } from "@/components/ui/tooltip";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  ActiveAgentProvider,
  activeAgentStorageKey,
  useActiveAgent,
} from "./active-agent-provider";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => undefined }),
  onControlPlaneRecovery: () => () => undefined,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
  useRouter: () => ({ push: vi.fn() }),
}));

const request = vi.mocked(controlPlaneRequest);
const agents = [
  {
    id: "studio",
    name: "Studio Mac",
    hostname: "studio.local",
    connectionStatus: "ONLINE",
  },
  {
    id: "build",
    name: "Build Mac",
    hostname: "build.local",
    connectionStatus: "OFFLINE",
  },
];
const pages = [
  {
    key: "commands",
    query: "query CommandManagement",
    element: <CommandsPage />,
  },
  {
    key: "workflows",
    query: "query WorkflowManagement",
    element: <WorkflowsPage />,
  },
  { key: "plans", query: "query AgentRuns", element: <RunsPage kind="PLAN" /> },
  {
    key: "sessions",
    query: "query AgentRuns",
    element: <RunsPage kind="SESSION" />,
  },
];

function GlobalSelection() {
  const { selectAgent } = useActiveAgent();
  return (
    <>
      <button onClick={() => selectAgent("build")}>Focus Build Mac</button>
      <button onClick={() => selectAgent(null)}>Clear focus</button>
    </>
  );
}

function renderPage(element: ReactNode) {
  return render(
    <ActiveAgentProvider userId="filter-test">
      <TooltipProvider>
        <GlobalSelection />
        {element}
      </TooltipProvider>
    </ActiveAgentProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  localStorage.clear();
  request.mockImplementation(async (query) => {
    if (query.includes("query ActiveAgentOptions")) return { agents } as never;
    if (query.includes("query CommandManagement"))
      return { commandDefinitions: [], commandRuns: { nodes: [] } } as never;
    if (query.includes("query WorkflowManagement"))
      return { workflows: { items: [] }, workflowRuns: { items: [] } } as never;
    if (query.includes("query AgentRuns"))
      return {
        agentRuns: { items: [], nextCursor: null, totalCount: 0 },
      } as never;
    throw new Error(`Unexpected query: ${query}`);
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("page agent filters", () => {
  test.each(pages)(
    "$key follows global focus and restores the local filter",
    async ({ key, query, element }) => {
      renderPage(element);
      const filter = screen.getByRole("combobox", { name: "Filter by agent" });
      expect(filter.textContent).toBe("All agents");
      await waitFor(() =>
        expect(
          request.mock.calls.some(
            ([text, variables]) =>
              text.includes(query) && variables?.agentId === null,
          ),
        ).toBe(true),
      );

      fireEvent.click(filter);
      fireEvent.change(
        await screen.findByRole("combobox", { name: "Search agents…" }),
        { target: { value: "studio.local" } },
      );
      fireEvent.click(
        await screen.findByRole("option", { name: "Studio Mac" }),
      );
      await waitFor(() => expect(filter.textContent).toBe("Studio Mac"));
      await waitFor(() =>
        expect(
          request.mock.calls.some(
            ([text, variables]) =>
              text.includes(query) && variables?.agentId === "studio",
          ),
        ).toBe(true),
      );
      const localQuery = request.mock.calls.find(
        ([text, variables]) =>
          text.includes(query) && variables?.agentId === "studio",
      )?.[0];
      expect(localQuery).toContain("agentId: $agentId");

      fireEvent.click(screen.getByText("Focus Build Mac"));
      await waitFor(() => expect(filter.hasAttribute("disabled")).toBe(true));
      expect(filter.textContent).toBe("Build Mac");
      expect(screen.getByText("Controlled by Active Agent")).toBeDefined();
      await waitFor(() =>
        expect(
          request.mock.calls.some(
            ([text, variables]) =>
              text.includes(query) && variables?.agentId === "build",
          ),
        ).toBe(true),
      );

      fireEvent.click(screen.getByText("Clear focus"));
      await waitFor(() => expect(filter.hasAttribute("disabled")).toBe(false));
      expect(filter.textContent).toBe("Studio Mac");
      expect(screen.queryByText("Controlled by Active Agent")).toBeNull();
      expect(
        JSON.parse(localStorage.getItem(activeAgentStorageKey("filter-test"))!)
          .pageAgents[key],
      ).toBe("studio");

      fireEvent.click(filter);
      fireEvent.click(
        await screen.findByRole("option", { name: "All agents" }),
      );
      await waitFor(() => expect(filter.textContent).toBe("All agents"));
    },
  );

  test.each(pages)(
    "$key loads the saved global focus without fetching all agents' runs",
    async ({ query, key, element }) => {
      localStorage.setItem(
        activeAgentStorageKey("filter-test"),
        JSON.stringify({
          activeAgentId: "build",
          pageAgents: { [key]: "studio" },
        }),
      );
      renderPage(element);
      await waitFor(() =>
        expect(
          request.mock.calls.some(
            ([text, variables]) =>
              text.includes(query) && variables?.agentId === "build",
          ),
        ).toBe(true),
      );
      expect(
        request.mock.calls
          .filter(([text]) => text.includes(query))
          .every(([, variables]) => variables?.agentId === "build"),
      ).toBe(true);
    },
  );
});
