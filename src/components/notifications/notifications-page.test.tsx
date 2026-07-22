import {
  act,
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

import { NotificationsPage } from "./notifications-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const now = "2026-07-22T02:00:00.000Z";
let nextChange: ((change: Record<string, unknown>) => void) | null = null;

const notification = {
  id: "notification-1",
  typeKey: "IOS_BUILD_SUCCEEDED",
  title: "iOS build succeeded",
  body: "Example · Debug · main",
  href: "/builds/build-1",
  resourceKind: "BUILD",
  resourceId: "build-1",
  worktreeId: "worktree-1",
  highlightColor: "blue",
  sidebarRequested: true,
  browserRequested: true,
  webPushRequested: false,
  sidebarDismissedAt: null,
  createdAt: now,
  updatedAt: now,
};

const preferences = [
  {
    key: "IOS_BUILD_SUCCEEDED",
    category: "BUILDS",
    label: "iOS build succeeded",
    description: "An iOS build finishes successfully.",
    sidebarEnabled: true,
    browserEnabled: true,
    webPushEnabled: false,
    updatedAt: null,
  },
  {
    key: "IOS_BUILD_FAILED",
    category: "BUILDS",
    label: "iOS build failed",
    description: "An iOS build finishes with a failure.",
    sidebarEnabled: true,
    browserEnabled: true,
    webPushEnabled: false,
    updatedAt: null,
  },
];

const webPushSubscription = {
  id: "subscription-1",
  endpoint: "https://push.example/subscription",
  expirationTime: null,
  locale: "en-US",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
  lastSeenAt: now,
  createdAt: now,
  updatedAt: now,
};

beforeEach(() => {
  nextChange = null;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
  subscriptions.mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      nextChange = (change) =>
        sink.next({ data: { notificationsChanged: change } } as never);
      return vi.fn();
    }),
  } as never);
  request.mockImplementation(async (query, variables) => {
    const operation = String(query);
    if (operation.includes("query NotificationsPage")) {
      return {
        notifications: {
          items: [notification],
          nextCursor: null,
          totalCount: 1,
        },
        notificationPreferences: preferences,
        webPushState: {
          configured: false,
          publicKey: null,
          subscriptionCount: 1,
        },
        webPushSubscriptions: [webPushSubscription],
      } as never;
    }
    if (operation.includes("mutation SaveNotificationPreference")) {
      const input = (variables as { input: Record<string, unknown> }).input;
      return {
        saveNotificationPreference: {
          ...preferences[0],
          ...input,
          key: input.typeKey,
        },
      } as never;
    }
    if (operation.includes("mutation DeleteNotifications")) {
      return { deleteNotifications: 1 } as never;
    }
    if (operation.includes("mutation DeleteAllNotifications")) {
      return { deleteAllNotifications: 1 } as never;
    }
    if (operation.includes("mutation TestWebPushSubscription")) {
      return { testWebPushSubscription: true } as never;
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NotificationsPage", () => {
  test("renders channel preferences and saves independent changes", async () => {
    render(<NotificationsPage />);

    expect(await screen.findByText("Example · Debug · main")).toBeDefined();
    const pushToggle = screen.getByRole("checkbox", {
      name: "Toggle Web Push for iOS build succeeded",
    });
    expect(pushToggle.getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(pushToggle);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SaveNotificationPreference"),
        {
          input: {
            typeKey: "IOS_BUILD_SUCCEEDED",
            sidebarEnabled: true,
            browserEnabled: true,
            webPushEnabled: true,
          },
        },
      ),
    );
  });

  test("uses telemetry-style day selection and permanently deletes it", async () => {
    render(<NotificationsPage />);
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Select notifications from/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DeleteNotifications"),
        expect.objectContaining({
          selection: expect.objectContaining({
            ranges: [
              expect.objectContaining({
                start: expect.any(String),
                end: expect.any(String),
              }),
            ],
          }),
        }),
      ),
    );
  });

  test("prepends live notifications", async () => {
    render(<NotificationsPage />);
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    await act(async () =>
      nextChange?.({
        kind: "CREATED",
        notificationId: "notification-2",
        notification: {
          ...notification,
          id: "notification-2",
          title: "iOS build failed",
          typeKey: "IOS_BUILD_FAILED",
        },
      }),
    );

    expect(screen.getAllByText("iOS build failed").length).toBeGreaterThan(1);
  });

  test("sends a test notification to a subscribed browser", async () => {
    render(<NotificationsPage />);

    expect(await screen.findByText("Chrome · macOS")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation TestWebPushSubscription"),
        { id: "subscription-1" },
      ),
    );
    expect(screen.getByRole("button", { name: "Sent" })).toBeDefined();
  });
});
