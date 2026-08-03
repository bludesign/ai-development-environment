import path from "node:path";
import { randomInt } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import {
  SCREENSHOT_PUBLIC_ORIGIN,
  SCREENSHOT_TIME,
  SCREENSHOT_TIME_ZONE,
} from "./playwright/screenshot-time";
import { MOCK_CREDENTIAL_ENCRYPTION_KEY } from "./scripts/mock-data/encryption-key";

const assignedPorts = new Set<number>();

function screenshotPort(environmentVariable: string): string {
  const configuredValue = process.env[environmentVariable];
  if (configuredValue) {
    const configuredPort = Number(configuredValue);
    if (
      !Number.isInteger(configuredPort) ||
      configuredPort < 1 ||
      configuredPort > 65_535
    ) {
      throw new Error(`Invalid ${environmentVariable}: ${configuredValue}`);
    }
    if (assignedPorts.has(configuredPort)) {
      throw new Error(
        `${environmentVariable} duplicates another screenshot port: ${configuredPort}`,
      );
    }
    assignedPorts.add(configuredPort);
    return String(configuredPort);
  }

  let port: number;
  do port = randomInt(10_000, 60_000);
  while (assignedPorts.has(port));
  assignedPorts.add(port);
  return String(port);
}

// `npm run screenshots*` supplies OS-selected free ports. Random fallbacks also keep direct
// `playwright test` invocations from contending for the old fixed ports.
const PORT = screenshotPort("SCREENSHOT_PORT");
const MOCK_API_PORT = "4322";
const AGENT_WS_PORT = screenshotPort("AGENT_WS_PORT");
const HOST = "127.0.0.1";
const baseURL = `http://${HOST}:${PORT}`;
const mockApiURL = `http://${HOST}:${MOCK_API_PORT}`;
const fixedServerTimePath = path.resolve(
  process.cwd(),
  "playwright/fixed-server-time.cjs",
);

// Absolute file URL so the standalone server resolves the same database regardless of its CWD.
const mockDatabaseUrl = `file:${path.resolve(process.cwd(), "prisma/mock.db")}`;

const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };

// Capture at 3x so text and icons stay crisp when the PNGs are viewed or scaled down.
const DEVICE_SCALE_FACTOR = 2;

export default defineConfig({
  testDir: "./playwright",
  outputDir: "./playwright/.results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: [["list"]],
  timeout: 90_000,
  use: {
    baseURL,
    trace: "off",
    timezoneId: SCREENSHOT_TIME_ZONE,
  },
  projects: [
    {
      name: "desktop-light",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        colorScheme: "light",
      },
    },
    {
      name: "desktop-dark",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        colorScheme: "dark",
      },
    },
    {
      name: "mobile-light",
      use: {
        ...devices["iPhone 13"],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        colorScheme: "light",
      },
    },
    {
      name: "mobile-dark",
      use: {
        ...devices["iPhone 13"],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        colorScheme: "dark",
      },
    },
  ],
  webServer: [
    {
      // Stub GitHub/Jira API. Pages backed by those integrations have no local tables, so
      // without it they render their "connect your account" empty state instead of data.
      command: `node_modules/.bin/tsx scripts/mock-api-server.ts --port ${MOCK_API_PORT}`,
      url: `${mockApiURL}/user`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: `node_modules/.bin/next start -p ${PORT} -H ${HOST}`,
      url: `${baseURL}/en`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        SCREENSHOT_DIST_DIR: ".next-mock",
        SCREENSHOT_TIME,
        DATABASE_URL: mockDatabaseUrl,
        NODE_ENV: "production",
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --require=${fixedServerTimePath}`.trim(),
        // The instrumentation hook binds this port while Next starts. It must be unique per
        // capture run because Playwright can run alongside dev servers and other captures.
        AGENT_WS_HOSTNAME: HOST,
        AGENT_WS_PORT,
        // Keep every GitHub call on the stub above; nothing reaches github.com.
        GITHUB_API_BASE_URL: mockApiURL,
        GITHUB_GRAPHQL_URL: `${mockApiURL}/graphql`,
        // Runtime GitHub calls would otherwise make the cache metrics depend on route order.
        // The seeded call history remains visible and deterministic.
        GITHUB_CACHE_LOGGING_DISABLED: "true",
        // Jira-backed routes run in parallel and would otherwise append to the same API call
        // history that the Jira cache screenshot displays. Keep only its seeded call history.
        JIRA_CACHE_LOGGING_DISABLED: "true",
        // Collecting sidebar usage queues a ccusage job per agent and waits out the collection
        // deadline. No agent answers during a capture, so those jobs sit queued for part of
        // every cycle and the Polling page's pending job counts would depend on when each
        // route was photographed. The poll still runs and reports on schedule; only the
        // collection is skipped, and the sidebar shows the seeded usage summary.
        SIDEBAR_USAGE_COLLECTION_DISABLED: "true",
        // Device enrollment refuses to issue a profile unless the app is served over public
        // HTTPS. The captured page only renders the form, so a placeholder origin is enough.
        PUBLIC_BASE_URL: SCREENSHOT_PUBLIC_ORIGIN,
        // Must match the key the seed encrypted mock.db's credentials with, or the app
        // rewrites every row on first use and the VACUUM that follows locks the database.
        // Explicitly override a developer's .env too; otherwise a local Vault/Keychain choice
        // makes every database-backed screenshot credential appear unavailable.
        CREDENTIAL_STORAGE_TYPE: "database",
        CREDENTIAL_ENCRYPTION_KEY: MOCK_CREDENTIAL_ENCRYPTION_KEY,
      },
    },
  ],
});
