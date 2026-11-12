import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import RepositoryDetailRoute from "@/app/[locale]/(dashboard)/dashboard/codebases/repositories/[repositoryId]/page";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { RepositoryDetailPage } from "./repository-detail-page";

vi.mock("@/lib/control-plane-client", () => ({
  onControlPlaneRecovery: vi.fn(() => () => {}),
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
  capabilities: [] as string[],
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
  preparations: [
    {
      id: "preparation-1",
      kind: "WRITE",
      path: ".env.local",
      contentSha256: "abc123",
      byteCount: 24,
      contentBase64: "aGVsbG8=",
      definitionHash: "definition-1",
    },
  ],
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
  let currentRepository: typeof repository;

  beforeEach(() => {
    currentRepository = repository;
    global.ResizeObserver = ResizeObserverMock;
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    subscriptions.mockReturnValue({ subscribe: vi.fn(() => vi.fn()) } as never);
    request.mockImplementation(async (query) => {
      if (String(query).includes("query RepositoryDetail")) {
        return {
          codebaseRepository: currentRepository,
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
      if (String(query).includes("query AndroidAppProject")) {
        return { androidAppProject: null } as never;
      }
      if (String(query).includes("mutation SaveRepositoryPreparations")) {
        return {
          saveCodebaseRepositoryPreparations: {
            preparations: repository.preparations,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    request.mockReset();
    subscriptions.mockReset();
  });

  test("opens the Android App tab from a repository settings link", async () => {
    render(
      await RepositoryDetailRoute({
        params: Promise.resolve({ locale: "en", repositoryId: "repository-1" }),
        searchParams: Promise.resolve({ tab: "android-app" }),
      }),
    );

    const tab = await screen.findByRole("tab", { name: "Android App" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("button", { name: "Enable Android builds" }),
    ).toBeDefined();
  });

  test("refreshes Android readiness when a checkout agent changes", async () => {
    type AgentUpdate = Pick<
      typeof agent,
      "id" | "connectionStatus" | "capabilities"
    >;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let publishAgentChange: ((changed: AgentUpdate) => void) | undefined;
    subscriptions.mockReturnValue({
      subscribe: vi.fn<
        ReturnType<typeof controlPlaneSubscriptions>["subscribe"]
      >((operation, sink) => {
        if (operation.query.includes("agentChanged")) {
          publishAgentChange = (changed) =>
            sink.next({ data: { agentChanged: changed } } as never);
        }
        return vi.fn();
      }),
    });

    render(
      <RepositoryDetailPage
        initialTab="android-app"
        repositoryId="repository-1"
      />,
    );
    const checkout = within(
      (await screen.findByText(/Studio Mac ·/)).closest("li")!,
    );
    expect(
      checkout.getByText("Android build support unavailable"),
    ).toBeDefined();
    expect(publishAgentChange).toBeDefined();

    const callCount = request.mock.calls.length;
    const ready = { ...agent, capabilities: ["android.build.run"] };
    await act(async () => {
      publishAgentChange!(agent);
      publishAgentChange!({ ...ready, id: "unrelated-agent" });
    });
    expect(request).toHaveBeenCalledTimes(callCount);

    const setCheckoutSnapshot = (changed: AgentUpdate) => {
      currentRepository = {
        ...repository,
        codebases: repository.codebases.map((codebase) =>
          codebase.agent.id === changed.id
            ? { ...codebase, agent: { ...codebase.agent, ...changed } }
            : codebase,
        ),
      };
    };

    setCheckoutSnapshot(ready);
    act(() => publishAgentChange!(ready));
    expect(
      await checkout.findByText("Android build tools ready"),
    ).toBeDefined();
    setCheckoutSnapshot({ ...ready, connectionStatus: "OFFLINE" });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(checkout.getByText("Agent offline")).toBeDefined();
  });

  test("edits shared repository settings and hosts iOS settings across agents", async () => {
    render(<RepositoryDetailPage repositoryId="repository-1" />);

    expect(await screen.findByText("Edit repository details")).toBeDefined();
    const checkbox = screen.getByRole("checkbox", {
      name: "Keep default branches up to date",
    });
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText("Default branch matches"), {
      target: { value: " release/*\nmain\n release/*\n\n" },
    });
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
            ).input?.keepBaseBranchUpToDate === false &&
            JSON.stringify(
              (variables as { input?: { defaultBranchPatterns?: string[] } })
                .input?.defaultBranchPatterns,
            ) === JSON.stringify(["release/*", "main"]),
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

  test("edits repository preparations and confirms atomic replacement", async () => {
    render(<RepositoryDetailPage repositoryId="repository-1" />);

    fireEvent.click(await screen.findByRole("tab", { name: "Preparations" }));
    expect(await screen.findByDisplayValue(".env.local")).toBeDefined();
    expect(screen.getByText("abc123")).toBeDefined();
    const contents = screen.getByLabelText("File contents");
    expect((contents as HTMLTextAreaElement).value).toBe("hello");
    fireEvent.change(contents, { target: { value: "updated contents" } });

    fireEvent.click(screen.getByRole("button", { name: "Save preparations" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Replace repository preparations?"),
    ).toBeDefined();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save preparations" }),
    );

    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([query, variables]) =>
            String(query).includes("mutation SaveRepositoryPreparations") &&
            (
              variables as {
                input?: {
                  preparations?: Array<{
                    id?: string;
                    contentBase64?: string;
                  }>;
                };
              }
            ).input?.preparations?.[0]?.id === "preparation-1" &&
            (
              variables as {
                input?: {
                  preparations?: Array<{ contentBase64?: string }>;
                };
              }
            ).input?.preparations?.[0]?.contentBase64 ===
              "dXBkYXRlZCBjb250ZW50cw==",
        ),
      ).toBe(true),
    );
  });
});
