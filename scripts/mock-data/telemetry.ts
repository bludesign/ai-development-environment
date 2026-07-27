import type { PrismaClient } from "../../src/generated/prisma/client";

import { minutesAgo } from "./time";

const DEVICE_IP = "203.0.113.42";
const SESSION_ID = "8f14e45f-ceea-467a-9a3c-acme00000001";

export async function seedTelemetry(prisma: PrismaClient): Promise<void> {
  const consoleLevels = ["debug", "info", "warning", "error"] as const;
  const consoleMessages: Record<(typeof consoleLevels)[number], string> = {
    debug: "Resolved feature flags from cache",
    info: "User signed in successfully",
    warning: "Retrying network request after timeout",
    error: "Failed to decode checkout response",
  };

  const consoleEntries = Array.from({ length: 12 }, (_, index) => {
    const level = consoleLevels[index % consoleLevels.length];
    const message = consoleMessages[level];
    return {
      id: `telemetry-console-${index + 1}`,
      entryType: "CONSOLE",
      clientTime: minutesAgo(index * 4 + 2),
      receivedAt: minutesAgo(index * 4 + 2),
      deviceIp: DEVICE_IP,
      level,
      category: ["network", "auth", "checkout", "ui"][index % 4],
      message,
      sessionId: SESSION_ID,
      searchText: `${level} ${message}`.toLowerCase(),
    };
  });

  const analyticsEvents = [
    { name: "screen_view", kind: "SCREEN_VIEW", screen: "Home" },
    { name: "screen_view", kind: "SCREEN_VIEW", screen: "Catalog" },
    { name: "add_to_cart", kind: "ACTION", screen: "Catalog" },
    { name: "begin_checkout", kind: "ACTION", screen: "Checkout" },
    { name: "purchase", kind: "CONVERSION", screen: "Checkout" },
    { name: "screen_view", kind: "SCREEN_VIEW", screen: "Profile" },
    { name: "app_open", kind: "LIFECYCLE", screen: "Home" },
    { name: "search", kind: "ACTION", screen: "Catalog" },
  ];

  const analyticsEntries = analyticsEvents.map((event, index) => ({
    id: `telemetry-analytics-${index + 1}`,
    entryType: "ANALYTICS",
    clientTime: minutesAgo(index * 6 + 3),
    receivedAt: minutesAgo(index * 6 + 3),
    deviceIp: DEVICE_IP,
    eventName: event.name,
    eventKind: event.kind,
    screenName: event.screen,
    sessionId: SESSION_ID,
    defaultParametersJson: JSON.stringify({
      appVersion: "3.4.1",
      platform: "iOS",
    }),
    additionalParametersJson: JSON.stringify({ screen: event.screen }),
    searchText: `${event.name} ${event.screen}`.toLowerCase(),
  }));

  await prisma.telemetryEntry.createMany({
    data: [...consoleEntries, ...analyticsEntries],
  });
}
