import type { PrismaClient } from "../../src/generated/prisma/client";

import { atTime, minutesAgo } from "./time";

const DEVICE_IP = "203.0.113.42";
const SESSION_ID = "8f14e45f-ceea-467a-9a3c-acme00000001";

/**
 * Console rows pinned to fixed wall-clock times across the two days before today, so the log
 * table always shows two fully-populated day groups whose timestamps read the same on every
 * seed. The relative block above keeps a handful of rows in the last hour.
 */
const FIXED_CONSOLE_ROWS: Array<{
  daysBack: number;
  hour: number;
  minute: number;
  level: "debug" | "info" | "warning" | "error";
  category: string;
  message: string;
}> = [
  { daysBack: 1, hour: 9, minute: 12, level: "info", category: "lifecycle", message: "Application became active" },
  { daysBack: 1, hour: 10, minute: 41, level: "debug", category: "network", message: "Prefetched catalog page 1 of 4" },
  { daysBack: 1, hour: 12, minute: 3, level: "warning", category: "storage", message: "Cache store exceeded its soft size limit" },
  { daysBack: 1, hour: 14, minute: 27, level: "error", category: "checkout", message: "Payment sheet dismissed before authorization" },
  { daysBack: 1, hour: 17, minute: 55, level: "info", category: "auth", message: "Refreshed access token from the keychain" },
  { daysBack: 2, hour: 8, minute: 34, level: "debug", category: "analytics", message: "Flushed 24 queued analytics events" },
  { daysBack: 2, hour: 11, minute: 19, level: "warning", category: "network", message: "Request retried after a 503 response" },
  { daysBack: 2, hour: 13, minute: 48, level: "error", category: "search", message: "Search index rebuild failed midway" },
  { daysBack: 2, hour: 16, minute: 6, level: "info", category: "ui", message: "Rendered the product detail screen" },
  { daysBack: 2, hour: 19, minute: 22, level: "debug", category: "storage", message: "Ran the pending schema migration" },
];

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

  const fixedConsoleEntries = FIXED_CONSOLE_ROWS.map((row, index) => {
    const clientTime = atTime(row.daysBack, row.hour, row.minute);
    return {
      id: `telemetry-console-fixed-${index + 1}`,
      entryType: "CONSOLE",
      clientTime,
      receivedAt: clientTime,
      deviceIp: DEVICE_IP,
      level: row.level,
      category: row.category,
      message: row.message,
      sessionId: SESSION_ID,
      searchText: `${row.level} ${row.message}`.toLowerCase(),
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
    data: [...consoleEntries, ...fixedConsoleEntries, ...analyticsEntries],
  });
}
