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

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { NotificationsPage } from "./notifications-page";

/* The page's toolbar hangs tooltips off its refresh control, and Radix reads
   the provider out of context rather than defaulting — so the page only mounts
   under one, the same way the app shell supplies it. */
function renderPage() {
  return render(
    <TooltipProvider>
      <NotificationsPage />
    </TooltipProvider>,
  );
}

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => () => undefined),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const now = "2026-07-22T02:00:00.000Z";
let nextChange: ((change: Record<string, unknown>) => void) | null = null;
let nextLiveActivitySettingsChange:
  ((change: Record<string, unknown>) => void) | null = null;
const defaultLiveActivitySettings = {
  includePlans: true,
  includeSessions: true,
  includeBuilds: true,
  includeWorkflows: true,
  includeCommands: true,
  includeGitHubActions: true,
  includeGitLabPipelines: true,
  updatedAt: now,
};
let serverLiveActivitySettings = { ...defaultLiveActivitySettings };

const notification = {
  id: "notification-1",
  typeKey: "IOS_BUILD_SUCCEEDED",
  title: "iOS build succeeded",
  body: "Example · Debug · main",
  href: "/dashboard/builds/build-1",
  resourceKind: "BUILD",
  resourceId: "build-1",
  worktreeId: "worktree-1",
  highlightColor: "blue",
  sidebarRequested: true,
  browserRequested: true,
  webPushRequested: false,
  apnsRequested: false,
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
    apnsEnabled: true,
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
    apnsEnabled: true,
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
let serverPushSubscriptions = [webPushSubscription];

const notificationDevice = {
  id: "device-1",
  clientRegistrationId: "ios-app-1",
  tokenMasked: "AAAAAAAA…AAAAAAAA",
  topic: "com.bludesign.aidevelopmentenvironment",
  environment: "PRODUCTION",
  displayName: "Test iPhone",
  deviceModel: "iPhone",
  osVersion: "26.0",
  appVersion: "1.0.0",
  appBuild: "1",
  locale: "en-US",
  status: "ACTIVE",
  lastFailureReason: null,
  lastFailureAt: null,
  lastRegisteredAt: now,
  lastDeliveredAt: null,
  createdAt: now,
  updatedAt: now,
};
let serverDevices = [notificationDevice];

const originalServiceWorker = Object.getOwnPropertyDescriptor(
  navigator,
  "serviceWorker",
);
const originalSecureContext = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext",
);

function installServiceWorker(value: ServiceWorkerContainer) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  nextChange = null;
  nextLiveActivitySettingsChange = null;
  serverLiveActivitySettings = { ...defaultLiveActivitySettings };
  serverPushSubscriptions = [webPushSubscription];
  serverDevices = [notificationDevice];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false })),
  });
  subscriptions.mockReturnValue({
    subscribe: vi.fn((operation, sink) => {
      if (String(operation.query).includes("LiveActivitySettingsChanged")) {
        nextLiveActivitySettingsChange = (change) =>
          sink.next({ data: { liveActivitySettingsChanged: change } } as never);
      } else {
        nextChange = (change) =>
          sink.next({ data: { notificationsChanged: change } } as never);
      }
      return vi.fn();
    }),
  } as never);
  request.mockImplementation(async (query, variables) => {
    const operation = String(query);
    if (
      operation.includes("query NotificationsPage") ||
      operation.includes("query NotificationSettings")
    ) {
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
        webPushSubscriptions: serverPushSubscriptions,
        notificationApnsState: { configured: true, deviceCount: 1 },
        notificationDevices: serverDevices,
        liveActivitySettings: serverLiveActivitySettings,
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
    if (operation.includes("mutation SaveLiveActivitySettings")) {
      const input = (variables as { input: Record<string, boolean> }).input;
      serverLiveActivitySettings = {
        ...serverLiveActivitySettings,
        ...input,
        updatedAt: "2026-07-22T02:00:01.000Z",
      };
      return { saveLiveActivitySettings: serverLiveActivitySettings } as never;
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
    if (operation.includes("mutation PrepareWebPush")) {
      return {
        prepareWebPush: {
          configured: true,
          publicKey: "public-key",
          subscriptionCount: serverPushSubscriptions.length,
        },
      } as never;
    }
    if (operation.includes("mutation TestNotificationDevice")) {
      return { testNotificationDevice: true } as never;
    }
    if (operation.includes("mutation RegisterWebPushSubscription")) {
      return {
        registerWebPushSubscription: {
          configured: true,
          publicKey: "public-key",
          subscriptionCount: serverPushSubscriptions.length + 1,
        },
      } as never;
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  if (originalServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  } else {
    delete (navigator as unknown as { serviceWorker?: ServiceWorkerContainer })
      .serviceWorker;
  }
  if (originalSecureContext) {
    Object.defineProperty(window, "isSecureContext", originalSecureContext);
  } else {
    delete (window as unknown as { isSecureContext?: boolean }).isSecureContext;
  }
});

describe("NotificationsPage", () => {
  test("does not show invented inclusion values after a failed settings load and retries loading", async () => {
    const implementation = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (query, variables, options) => {
      if (String(query).includes("query NotificationSettings") && fail) {
        throw new Error("Notification settings could not be loaded");
      }
      return implementation(query, variables, options);
    });
    renderPage();
    await screen.findByText("Example · Debug · main");
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(
      await screen.findByText("Notification settings could not be loaded"),
    ).toBeDefined();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    const plans = await screen.findByRole("switch", {
      name: /^Plans$/,
    });
    expect(plans.getAttribute("aria-checked")).toBe("true");
    expect(
      screen.queryByText("Notification settings could not be loaded"),
    ).toBeNull();
  });

  test("saves only the changed Live Activity category and allows every category to be excluded", async () => {
    serverLiveActivitySettings = {
      ...defaultLiveActivitySettings,
      includePlans: false,
      includeSessions: false,
      includeBuilds: false,
      includeWorkflows: false,
      includeCommands: false,
      includeGitLabPipelines: false,
    };
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const actions = await screen.findByRole("switch", {
      name: "GitHub Actions runs",
    });
    expect(screen.getAllByRole("switch")).toHaveLength(7);
    expect(actions.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(actions);
    await waitFor(() =>
      expect(actions.getAttribute("aria-checked")).toBe("false"),
    );
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation SaveLiveActivitySettings"),
      { input: { includeGitHubActions: false } },
    );
    expect(
      screen
        .getAllByRole("switch")
        .every((toggle) => toggle.getAttribute("aria-checked") === "false"),
    ).toBe(true);
  });

  test("keeps persisted values after a failed Live Activity save and retries the exact change", async () => {
    const implementation = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (query, variables, options) => {
      if (String(query).includes("mutation SaveLiveActivitySettings") && fail) {
        throw new Error("Unable to save Live Activity settings");
      }
      return implementation(query, variables, options);
    });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const actions = await screen.findByRole("switch", {
      name: "GitHub Actions runs",
    });
    fireEvent.click(actions);
    expect(
      await screen.findByText("Unable to save Live Activity settings"),
    ).toBeDefined();
    expect(actions.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(actions.hasAttribute("disabled")).toBe(false));
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    await waitFor(() =>
      expect(actions.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      screen.queryByText("Unable to save Live Activity settings"),
    ).toBeNull();
  });

  test("retries settings reload errors separately without discarding a failed Live Activity save", async () => {
    const implementation = request.getMockImplementation()!;
    let failLoad = false;
    let failSave = true;
    request.mockImplementation(async (query, variables, options) => {
      if (String(query).includes("query NotificationSettings") && failLoad)
        throw new Error("Notification settings could not be loaded");
      if (
        String(query).includes("mutation SaveLiveActivitySettings") &&
        failSave
      )
        throw new Error("Unable to save Live Activity settings");
      return implementation(query, variables, options);
    });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const actions = await screen.findByRole("switch", {
      name: "GitHub Actions runs",
    });
    fireEvent.click(actions);
    await screen.findByText("Unable to save Live Activity settings");

    failLoad = true;
    await act(async () => nextChange?.({ kind: "DEVICES_CHANGED" }));
    await screen.findByText("Notification settings could not be loaded");
    failLoad = false;
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    await screen.findByText("Unable to save Live Activity settings");
    expect(
      request.mock.calls.filter(([query]) =>
        String(query).includes("mutation SaveLiveActivitySettings"),
      ),
    ).toHaveLength(1);
    expect(actions.getAttribute("aria-checked")).toBe("true");

    failSave = false;
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    await waitFor(() =>
      expect(actions.getAttribute("aria-checked")).toBe("false"),
    );
    expect(
      screen.queryByText("Unable to save Live Activity settings"),
    ).toBeNull();
  });

  test("disables category toggles while saving and keeps newer subscribed settings over a late save response", async () => {
    const implementation = request.getMockImplementation()!;
    let finishSave: ((value: never) => void) | undefined;
    request.mockImplementation(async (query, variables, options) => {
      if (String(query).includes("mutation SaveLiveActivitySettings")) {
        return new Promise<never>((resolve) => {
          finishSave = resolve;
        });
      }
      return implementation(query, variables, options);
    });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const actions = await screen.findByRole("switch", {
      name: "GitHub Actions runs",
    });
    fireEvent.click(actions);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("switch")
          .every((toggle) => toggle.hasAttribute("disabled")),
      ).toBe(true),
    );
    await act(async () =>
      nextLiveActivitySettingsChange?.({
        ...defaultLiveActivitySettings,
        includePlans: false,
        updatedAt: "2026-07-22T02:00:02.000Z",
      }),
    );
    await act(async () =>
      finishSave?.({
        saveLiveActivitySettings: {
          ...defaultLiveActivitySettings,
          includeGitHubActions: false,
          updatedAt: "2026-07-22T02:00:01.000Z",
        },
      } as never),
    );
    await waitFor(() => expect(actions.hasAttribute("disabled")).toBe(false));
    expect(actions.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: /^Plans$/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("refreshes Live Activity settings from external changes and ignores older events", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const actions = await screen.findByRole("switch", {
      name: "GitHub Actions runs",
    });
    await act(async () =>
      nextLiveActivitySettingsChange?.({
        ...defaultLiveActivitySettings,
        includeGitHubActions: false,
        updatedAt: "2026-07-22T02:00:02.000Z",
      }),
    );
    expect(actions.getAttribute("aria-checked")).toBe("false");
    await act(async () =>
      nextLiveActivitySettingsChange?.(defaultLiveActivitySettings),
    );
    expect(actions.getAttribute("aria-checked")).toBe("false");
    expect(
      request.mock.calls.filter(([query]) =>
        String(query).includes("mutation SaveLiveActivitySettings"),
      ),
    ).toHaveLength(0);
  });

  test("renders channel preferences and saves independent changes", async () => {
    renderPage();

    expect(await screen.findByText("Example · Debug · main")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    const pushToggle = await screen.findByRole("checkbox", {
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
            apnsEnabled: true,
          },
        },
      ),
    );
  });

  test("uses telemetry-style day selection and permanently deletes it", async () => {
    renderPage();
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

  test("does not materialize loaded IDs when selecting every notification", async () => {
    renderPage();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all notifications" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DeleteNotifications"),
        expect.objectContaining({
          selection: expect.objectContaining({ all: true, ids: [] }),
        }),
      ),
    );
  });

  test("reselects one notification from an excluded day", async () => {
    renderPage();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all notifications" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Select notifications from/ }),
    );
    const item = screen.getByRole("checkbox", {
      name: "Select iOS build succeeded",
    });
    fireEvent.click(item);
    expect(item.getAttribute("data-state")).toBe("checked");
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation DeleteNotifications"),
        expect.objectContaining({
          selection: expect.objectContaining({
            all: true,
            ids: ["notification-1"],
            excludedRanges: [
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
    renderPage();
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

    /* Both notifications share a day, so the group holds them in arrival
       order — the newest one has to sit at the top of it. */
    expect(
      screen
        .getAllByRole("link", { name: /^iOS build/ })
        .map((link) => link.textContent),
    ).toEqual(["iOS build failed", "iOS build succeeded"]);
  });

  test("keeps delivery setup and preferences on the settings tab", async () => {
    renderPage();
    expect(await screen.findByText("Example · Debug · main")).toBeDefined();
    expect(screen.queryByText("Notification types")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));

    expect(screen.getByText("Notification types")).toBeDefined();
    expect(screen.getByText("Subscribed browsers")).toBeDefined();
    expect(screen.queryByText("Example · Debug · main")).toBeNull();
  });

  test("sends a test notification to a subscribed browser", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const browserRow = (await screen.findByText("Chrome · macOS")).closest(
      "tr",
    );
    expect(browserRow).not.toBeNull();
    fireEvent.click(within(browserRow!).getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation TestWebPushSubscription"),
        { id: "subscription-1" },
      ),
    );
    expect(
      within(browserRow!).getByRole("button", { name: "Sent" }),
    ).toBeDefined();
  });

  test("sends a test notification to a registered device", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const deviceRow = (await screen.findByText("Test iPhone")).closest("tr");
    expect(deviceRow).not.toBeNull();
    fireEvent.click(within(deviceRow!).getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation TestNotificationDevice"),
        { id: "device-1" },
      ),
    );
    expect(
      within(deviceRow!).getByRole("button", { name: "Sent" }),
    ).toBeDefined();
  });

  test("tells the user to configure APNs before devices can be reached", async () => {
    request.mockImplementation(async (query) => {
      const operation = String(query);
      if (
        operation.includes("query NotificationsPage") ||
        operation.includes("query NotificationSettings")
      ) {
        return {
          notifications: { items: [], nextCursor: null, totalCount: 0 },
          notificationPreferences: preferences,
          webPushState: {
            configured: false,
            publicKey: null,
            subscriptionCount: 0,
          },
          webPushSubscriptions: [],
          notificationApnsState: { configured: false, deviceCount: 0 },
          notificationDevices: [],
          liveActivitySettings: serverLiveActivitySettings,
        } as never;
      }
      throw new Error(`Unexpected request: ${operation}`);
    });
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));

    expect(
      await screen.findByText(
        "Add the APNs provider key in Settings before devices can receive notifications.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("No devices are registered for native notifications."),
    ).toBeDefined();
  });

  test("waits for an active service worker before creating a subscription", async () => {
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    });
    vi.stubGlobal("PushManager", class PushManager {});
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    const subscription = {
      endpoint: webPushSubscription.endpoint,
      toJSON: () => ({
        endpoint: webPushSubscription.endpoint,
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
    } as unknown as PushSubscription;
    const installingPushManager = {
      getSubscription: vi.fn(),
      subscribe: vi.fn(),
    };
    const activePushManager = {
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(subscription),
    };
    installServiceWorker({
      getRegistration: vi.fn().mockResolvedValue(null),
      register: vi
        .fn()
        .mockResolvedValue({ pushManager: installingPushManager }),
      ready: Promise.resolve({ pushManager: activePushManager }),
    } as unknown as ServiceWorkerContainer);

    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const subscribe = await screen.findByRole("button", { name: "Subscribe" });
    await waitFor(() => expect(subscribe.hasAttribute("disabled")).toBe(false));
    fireEvent.click(subscribe);

    await waitFor(() => expect(activePushManager.subscribe).toHaveBeenCalled());
    expect(installingPushManager.getSubscription).not.toHaveBeenCalled();
    expect(installingPushManager.subscribe).not.toHaveBeenCalled();
  });

  test("registers a local subscription that is missing from the server", async () => {
    serverPushSubscriptions = [];
    vi.stubGlobal("Notification", {
      permission: "granted",
      requestPermission: vi.fn().mockResolvedValue("granted"),
    });
    vi.stubGlobal("PushManager", class PushManager {});
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    const subscription = {
      endpoint: webPushSubscription.endpoint,
      toJSON: () => ({
        endpoint: webPushSubscription.endpoint,
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
    } as unknown as PushSubscription;
    const pushManager = {
      getSubscription: vi.fn().mockResolvedValue(subscription),
      subscribe: vi.fn(),
    };
    installServiceWorker({
      getRegistration: vi.fn().mockResolvedValue({ pushManager }),
      register: vi.fn().mockResolvedValue({ pushManager }),
      ready: Promise.resolve({ pushManager }),
    } as unknown as ServiceWorkerContainer);

    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    const subscribe = await screen.findByRole("button", { name: "Subscribe" });
    await waitFor(() => expect(subscribe.hasAttribute("disabled")).toBe(false));
    fireEvent.click(subscribe);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RegisterWebPushSubscription"),
        expect.objectContaining({
          input: expect.objectContaining({
            endpoint: webPushSubscription.endpoint,
          }),
        }),
      ),
    );
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });
});
