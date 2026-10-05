import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppShell } from "@/components/app-shell";
import { AppDetailPage } from "@/components/apps/app-detail-page";
import type { ManagedApp } from "@/components/apps/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard/action-center",
  push: vi.fn(),
}));
const subscribe = vi.hoisted(() =>
  vi.fn<
    (
      payload: { query: string },
      sink: { next: (result: { data: Record<string, unknown> }) => void },
    ) => () => void
  >(() => vi.fn()),
);

vi.mock("@/components/worktrees/worktrees-page", () => ({
  WorktreesPage: () => <p>App worktrees</p>,
}));

vi.mock("@/i18n/navigation", async () => {
  const React = await import("react");
  return {
    Link: ({
      href,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
      React.createElement("a", { href, ...props }),
    usePathname: () => navigation.pathname,
    useRouter: () => ({ push: navigation.push }),
  };
});

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
  onControlPlaneMutation: vi.fn(() => vi.fn()),
  controlPlaneSubscriptions: vi.fn(() => ({
    subscribe,
  })),
  onControlPlaneConnected: vi.fn(() => vi.fn()),
}));

const requestMock = vi.mocked(controlPlaneRequest);

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: width < 768,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

function shell({
  children = <p>Page content</p>,
  leftDefaultOpen = true,
  rightDefaultOpen = true,
}: {
  children?: ReactNode;
  leftDefaultOpen?: boolean;
  rightDefaultOpen?: boolean;
} = {}) {
  return (
    <TooltipProvider>
      <AppShell
        currentUser={{
          id: "test-user",
          name: "Screenshot User",
          email: "user@example.com",
          image: null,
        }}
        leftDefaultOpen={leftDefaultOpen}
        rightDefaultOpen={rightDefaultOpen}
      >
        {children}
      </AppShell>
    </TooltipProvider>
  );
}

function renderShell(options: Parameters<typeof shell>[0] = {}) {
  return render(shell(options));
}

function managedApp(id: string, name: string): ManagedApp {
  return {
    id,
    name,
    description: "",
    repositories: [],
    agentIds: [],
    counts: {
      repositories: 0,
      codebases: 0,
      worktrees: 0,
      dirtyWorktrees: 0,
      plans: 0,
      sessions: 0,
      builds: 0,
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; path=/; max-age=0`;
    }
  }
}

describe("AppShell", () => {
  beforeEach(() => {
    setViewportWidth(1280);
    navigation.pathname = "/dashboard/action-center";
    navigation.push.mockReset();
    clearCookies();
    requestMock.mockReset();
    subscribe.mockClear();
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query ActiveAgentOptions"))
        return { agents: [] } as never;
      if (query.includes("query NavigationFeatures")) {
        return {
          cacheServerSettings: { configured: false },
          sourceControlIntegrationState: {
            github: { configured: true, webhooksEnabled: false },
            gitlab: { configured: false, webhooksEnabled: false },
          },
          jiraWebhooksEnabled: false,
        } as never;
      }
      return { sidebarNotifications: [] } as never;
    });
  });

  afterEach(() => {
    cleanup();
    clearCookies();
  });

  test("opens both sidebars on desktop by default and toggles them independently", async () => {
    renderShell();

    await screen.findByRole("link", { name: "Actions" });

    expect(
      screen.getByRole("link", { name: "Usage" }).getAttribute("href"),
    ).toBe("/ai/usage");
    expect(
      screen
        .getAllByRole("link", { name: "Action Center" })
        .some(
          (link) => link.getAttribute("href") === "/dashboard/action-center",
        ),
    ).toBe(true);
    expect(
      screen.getByRole("link", { name: "Comments" }).getAttribute("href"),
    ).toBe("/github/comments");
    expect(
      screen.getByRole("link", { name: "Actions" }).getAttribute("href"),
    ).toBe("/github/actions");
    expect(
      screen.getByRole("link", { name: "Devices" }).getAttribute("href"),
    ).toBe("/system/devices");
    expect(
      screen
        .getByText("Screenshot User")
        .closest('[data-slot="sidebar-footer"]')?.className,
    ).toContain("gap-0");
    expect(
      screen
        .getAllByRole("link", { name: "Cache" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/github/cache", "/jira/cache"]);

    const leftToggle = screen.getByRole("button", {
      name: "Hide navigation",
    });
    const rightToggle = screen.getByRole("button", {
      name: "Hide notifications",
    });

    fireEvent.click(leftToggle);
    expect(
      screen.getByRole("button", { name: "Show navigation" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Hide notifications" }),
    ).toBeDefined();
    expect(document.cookie).toContain(`${LEFT_SIDEBAR_COOKIE}=false`);
    expect(document.cookie).not.toContain(RIGHT_SIDEBAR_COOKIE);

    fireEvent.click(rightToggle);
    expect(
      screen.getByRole("button", { name: "Show notifications" }),
    ).toBeDefined();
    expect(document.cookie).toContain(`${RIGHT_SIDEBAR_COOKIE}=false`);
  });

  test("shows the GitHub webhooks page only while webhooks are enabled", async () => {
    const disabled = renderShell();
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("sourceControlIntegrationState"),
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(screen.queryByRole("link", { name: "Webhooks" })).toBeNull();
    disabled.unmount();

    requestMock.mockImplementation(async (query) => {
      if (query.includes("query NavigationFeatures")) {
        return {
          cacheServerSettings: { configured: false },
          sourceControlIntegrationState: {
            github: { configured: true, webhooksEnabled: true },
            gitlab: { configured: false, webhooksEnabled: false },
          },
          jiraWebhooksEnabled: false,
        } as never;
      }
      return { sidebarNotifications: [] } as never;
    });
    renderShell();

    expect(
      (await screen.findByRole("link", { name: "Webhooks" })).getAttribute(
        "href",
      ),
    ).toBe("/github/webhooks");
  });

  test.each([
    { name: "GitHub only", github: true, gitlab: false },
    { name: "GitLab only", github: false, gitlab: true },
    { name: "both providers", github: true, gitlab: true },
    { name: "neither provider", github: false, gitlab: false },
  ])("shows provider navigation for $name", async ({ github, gitlab }) => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query NavigationFeatures")) {
        return {
          cacheServerSettings: { configured: false },
          sourceControlIntegrationState: {
            github: { configured: github, webhooksEnabled: false },
            gitlab: { configured: gitlab, webhooksEnabled: false },
          },
          jiraWebhooksEnabled: false,
        } as never;
      }
      return { sidebarNotifications: [] } as never;
    });

    renderShell();

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("sourceControlIntegrationState"),
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(
        screen.queryByRole("link", { name: "Pull Requests" }) !== null,
      ).toBe(github);
      expect(
        screen.queryByRole("link", { name: "Merge Requests" }) !== null,
      ).toBe(gitlab);
    });
  });

  test("uses independently restored desktop defaults", () => {
    renderShell({ leftDefaultOpen: false, rightDefaultOpen: true });

    expect(
      screen.getByRole("button", { name: "Show navigation" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Hide notifications" }),
    ).toBeDefined();
  });

  test("keeps the sticky header outside the page scroll container", () => {
    renderShell();

    const main = screen.getByRole("main");
    expect(main.className).toContain("overflow-y-auto");
    expect(main.querySelector("header")).toBeNull();
    expect(main.previousElementSibling?.tagName).toBe("HEADER");
  });

  test("left-aligns the accessible breadcrumb between the edge toggles", () => {
    renderShell();

    const breadcrumb = screen.getByRole("navigation", {
      name: "Breadcrumb",
    });
    const header = breadcrumb.closest("header");
    const navigationToggle = screen.getByRole("button", {
      name: "Hide navigation",
    });
    const notificationsToggle = screen.getByRole("button", {
      name: "Hide notifications",
    });

    expect(
      within(breadcrumb)
        .getByText("Action Center")
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(breadcrumb).getByText("Action Center").className,
    ).not.toContain("max-w-");
    expect(breadcrumb.className).toContain("flex-1");
    expect(
      navigationToggle.compareDocumentPosition(breadcrumb) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      breadcrumb.compareDocumentPosition(notificationsToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(header).not.toBeNull();
  });

  test("compacts deep breadcrumbs on small screens without invalid links", () => {
    navigation.pathname = "/github/pull-requests/acme/widgets/42";
    setViewportWidth(375);
    renderShell();

    const breadcrumb = screen.getByRole("navigation", {
      name: "Breadcrumb",
    });
    expect(within(breadcrumb).getByText("GitHub")).toBeDefined();
    expect(
      within(breadcrumb).queryByRole("link", { name: "GitHub" }),
    ).toBeNull();
    expect(
      within(breadcrumb)
        .getByRole("link", { name: "Pull Requests" })
        .getAttribute("href"),
    ).toBe("/github/pull-requests");
    expect(within(breadcrumb).queryByRole("link", { name: "acme" })).toBeNull();
    expect(
      within(breadcrumb).getByText("acme").parentElement?.className,
    ).toContain("hidden");
    expect(
      within(breadcrumb)
        .getByText("More")
        .closest('[data-slot="breadcrumb-item"]')?.className,
    ).toContain("sm:hidden");
    expect(
      within(breadcrumb)
        .getByText("Loading…")
        .parentElement?.getAttribute("aria-current"),
    ).toBe("page");
  });

  test("shows an asynchronously loaded app title and refreshes it after a rename", async () => {
    const app = managedApp("app-id", "Mobile app");
    const originalRequest = requestMock.getMockImplementation()!;
    let resolveApp!: (value: { app: ManagedApp }) => void;
    const pending = new Promise<{ app: ManagedApp }>((resolve) => {
      resolveApp = resolve;
    });
    requestMock.mockImplementation((query, variables, options) =>
      query.includes("query AppDetail")
        ? (pending as never)
        : originalRequest(query, variables, options),
    );
    navigation.pathname = "/dashboard/apps/app-id?view=worktrees";
    renderShell({
      children: <AppDetailPage appId="app-id" view="worktrees" />,
    });
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).queryByText("app-id")).toBeNull();
    expect(
      breadcrumb.querySelector('[data-slot="breadcrumb-loading"]'),
    ).not.toBeNull();
    expect(breadcrumb.querySelector('[aria-busy="true"]')).not.toBeNull();
    await waitFor(() => {
      expect(
        requestMock.mock.calls.some(([query]) =>
          query.includes("query AppDetail"),
        ),
      ).toBe(true);
    });
    await act(async () => resolveApp({ app }));
    expect(
      (await within(breadcrumb).findByText("Mobile app")).getAttribute(
        "aria-current",
      ),
    ).toBe("page");
    expect(within(breadcrumb).queryByText("app-id")).toBeNull();
    expect(
      breadcrumb.querySelector('[data-slot="breadcrumb-loading"]'),
    ).toBeNull();
    expect(breadcrumb.querySelector('[aria-busy="true"]')).toBeNull();
    expect(
      within(breadcrumb)
        .getByRole("link", { name: "Apps" })
        .getAttribute("href"),
    ).toBe("/dashboard/apps");

    requestMock.mockImplementation((query, variables, options) =>
      query.includes("query AppDetail")
        ? Promise.resolve({
            app: { ...app, name: "Renamed mobile app" },
          } as never)
        : originalRequest(query, variables, options),
    );
    const appChanges = subscribe.mock.calls.find(([payload]) =>
      payload.query.includes("AppSummaryAppsChanged"),
    )![1];
    act(() => appChanges.next({ data: { appsChanged: { id: app.id } } }));
    expect(
      await within(breadcrumb).findByText("Renamed mobile app"),
    ).toBeDefined();
    expect(
      await screen.findByRole("heading", {
        name: "Renamed mobile app",
        level: 1,
      }),
    ).toBeDefined();
    expect(
      requestMock.mock.calls.filter(([query]) =>
        query.includes("query AppDetail"),
      ),
    ).toHaveLength(2);
  });

  test("uses a placeholder in server-rendered HTML before detail-page effects run", () => {
    navigation.pathname =
      "/dashboard/apps/9b635047-5ca5-44ae-b4c6-572a935fc1dd";
    const html = renderToString(
      shell({
        children: (
          <AppDetailPage
            appId="9b635047-5ca5-44ae-b4c6-572a935fc1dd"
            view="worktrees"
          />
        ),
      }),
    );
    expect(html).toContain('data-slot="breadcrumb-loading"');
    expect(html).toContain("Loading…");
    expect(html).not.toContain("9b635047-5ca5-44ae-b4c6-572a935fc1dd");
  });

  test("replaces the skeleton with Details when loading fails", async () => {
    const originalRequest = requestMock.getMockImplementation()!;
    requestMock.mockImplementation((query, variables, options) =>
      query.includes("query AppDetail")
        ? Promise.reject(new Error("Failed to load app"))
        : originalRequest(query, variables, options),
    );
    navigation.pathname = "/dashboard/apps/app-id";
    renderShell({
      children: <AppDetailPage appId="app-id" view="worktrees" />,
    });
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    await within(breadcrumb).findByText("Details");
    expect(within(breadcrumb).queryByText("app-id")).toBeNull();
    expect(
      breadcrumb.querySelector('[data-slot="breadcrumb-loading"]'),
    ).toBeNull();
  });

  test("does not carry an app's title to a different app while it is loading or missing", async () => {
    const originalRequest = requestMock.getMockImplementation()!;
    let resolveSecond!: (value: { app: ManagedApp | null }) => void;
    const pending = new Promise<{ app: ManagedApp | null }>((resolve) => {
      resolveSecond = resolve;
    });
    requestMock.mockImplementation((query, variables, options) => {
      if (query.includes("query AppDetail")) {
        return variables?.id === "first"
          ? Promise.resolve({ app: managedApp("first", "First app") } as never)
          : (pending as never);
      }
      return originalRequest(query, variables, options);
    });
    navigation.pathname = "/dashboard/apps/first";
    const page = renderShell({
      children: <AppDetailPage appId="first" view="worktrees" />,
    });
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    await within(breadcrumb).findByText("First app");

    navigation.pathname = "/dashboard/apps/second";
    page.rerender(
      shell({ children: <AppDetailPage appId="second" view="worktrees" /> }),
    );
    expect(within(breadcrumb).queryByText("First app")).toBeNull();
    expect(
      within(breadcrumb)
        .getByText("Loading…")
        .parentElement?.getAttribute("aria-current"),
    ).toBe("page");
    await act(async () => resolveSecond({ app: null }));
    expect(within(breadcrumb).queryByText("First app")).toBeNull();
    expect(await within(breadcrumb).findByText("Details")).toBeDefined();
    expect(
      breadcrumb.querySelector('[data-slot="breadcrumb-loading"]'),
    ).toBeNull();

    navigation.pathname = "/dashboard/apps";
    page.rerender(shell());
    expect(within(breadcrumb).queryByText("First app")).toBeNull();
    expect(within(breadcrumb).queryByText("second")).toBeNull();
    expect(
      within(breadcrumb).getByText("Apps").getAttribute("aria-current"),
    ).toBe("page");
  });

  test.each([
    ["/dashboard/apps", "Dashboard", "Apps"],
    ["/ai/skills", "AI", "Skills"],
    ["/debugging/sse", "Debugging", "SSE Endpoints"],
    ["/github/cache", "GitHub", "Cache"],
    ["/gitlab/cache", "GitLab", "Cache"],
    ["/jira/webhooks", "Jira", "Webhooks"],
    ["/system/settings", "System", "Settings"],
  ])("shows the section and current page for %s", (pathname, section, page) => {
    navigation.pathname = pathname;
    renderShell();

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(breadcrumb)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([section, page]);
    expect(
      within(breadcrumb).getByText(page).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(breadcrumb).queryByRole("link", { name: section }),
    ).toBeNull();
  });

  test("owns consistent page gutters and removes page-level width caps", () => {
    renderShell();

    const pageContent = screen
      .getByRole("main")
      .querySelector<HTMLElement>('[data-slot="page-content"]');
    expect(pageContent).not.toBeNull();
    expect(pageContent?.className).toContain("p-4");
    expect(pageContent?.className).toContain("sm:p-6");
    expect(pageContent?.className).toContain("[&>*]:!mx-0");
    expect(pageContent?.className).toContain("[&>*]:!w-full");
    expect(pageContent?.className).toContain("[&>*]:!max-w-none");
  });

  test("starts closed on mobile and opens the requested accessible sheet", async () => {
    setViewportWidth(375);
    renderShell();

    const navigationToggle = await screen.findByRole("button", {
      name: "Show navigation",
    });
    expect(
      screen.getByRole("button", { name: "Show notifications" }),
    ).toBeDefined();

    fireEvent.click(navigationToggle);
    const navigationDialog = await screen.findByRole("dialog", {
      name: "Navigation",
    });
    expect(navigationDialog).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show notifications" }));
    expect(
      await screen.findByRole("dialog", { name: "Notifications" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Close notifications" }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Close notifications" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Notifications" }),
      ).toBeNull();
    });
  });
});
