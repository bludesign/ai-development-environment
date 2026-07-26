import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";

const navigation = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/i18n/navigation", async () => {
  const React = await import("react");
  return {
    Link: ({
      href,
      ...props
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
      React.createElement("a", { href, ...props }),
    usePathname: () => navigation.pathname,
  };
});

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(() => ({
    subscribe: vi.fn(() => vi.fn()),
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

function renderShell({
  leftDefaultOpen = true,
  rightDefaultOpen = true,
}: {
  leftDefaultOpen?: boolean;
  rightDefaultOpen?: boolean;
} = {}) {
  return render(
    <TooltipProvider>
      <AppShell
        leftDefaultOpen={leftDefaultOpen}
        rightDefaultOpen={rightDefaultOpen}
      >
        <p>Page content</p>
      </AppShell>
    </TooltipProvider>,
  );
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
    navigation.pathname = "/";
    clearCookies();
    requestMock.mockReset();
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query NavigationFeatures")) {
        return {
          cacheServerSettings: { configured: false },
          githubWebhooksEnabled: false,
        } as never;
      }
      return { sidebarNotifications: [] } as never;
    });
  });

  afterEach(() => {
    cleanup();
    clearCookies();
  });

  test("opens both sidebars on desktop by default and toggles them independently", () => {
    renderShell();

    expect(
      screen.getByRole("link", { name: "Usage" }).getAttribute("href"),
    ).toBe("/usage");
    expect(
      screen
        .getAllByRole("link", { name: "Action Center" })
        .some((link) => link.getAttribute("href") === "/action-center"),
    ).toBe(true);
    expect(
      screen.getByRole("link", { name: "Comments" }).getAttribute("href"),
    ).toBe("/comments");
    expect(
      screen.getByRole("link", { name: "Actions" }).getAttribute("href"),
    ).toBe("/actions");
    expect(
      screen.getByRole("link", { name: "Devices" }).getAttribute("href"),
    ).toBe("/devices");
    expect(
      screen
        .getAllByRole("link", { name: "Cache" })
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/github-cache", "/jira-cache"]);

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
        expect.stringContaining("githubWebhooksEnabled"),
      );
    });
    expect(screen.queryByRole("link", { name: "Webhooks" })).toBeNull();
    disabled.unmount();

    requestMock.mockImplementation(async (query) => {
      if (query.includes("query NavigationFeatures")) {
        return {
          cacheServerSettings: { configured: false },
          githubWebhooksEnabled: true,
        } as never;
      }
      return { sidebarNotifications: [] } as never;
    });
    renderShell();

    expect(
      (await screen.findByRole("link", { name: "Webhooks" })).getAttribute(
        "href",
      ),
    ).toBe("/webhooks");
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
      within(breadcrumb).getByText("Welcome").getAttribute("aria-current"),
    ).toBe("page");
    expect(within(breadcrumb).getByText("Welcome").className).not.toContain(
      "max-w-",
    );
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
    navigation.pathname = "/pull-requests/acme/widgets/42";
    setViewportWidth(375);
    renderShell();

    const breadcrumb = screen.getByRole("navigation", {
      name: "Breadcrumb",
    });
    expect(
      within(breadcrumb)
        .getByRole("link", { name: "Pull Requests" })
        .getAttribute("href"),
    ).toBe("/pull-requests");
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
      within(breadcrumb).getByText("42").getAttribute("aria-current"),
    ).toBe("page");
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
