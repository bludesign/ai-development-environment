import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { MOCK_CREDENTIAL_ENCRYPTION_KEY } from "./scripts/mock-data/encryption-key";

const PORT = process.env.SCREENSHOT_PORT ?? "4321";
const MOCK_API_PORT = process.env.MOCK_API_PORT ?? "4322";
const HOST = "127.0.0.1";
const baseURL = `http://${HOST}:${PORT}`;
const mockApiURL = `http://${HOST}:${MOCK_API_PORT}`;

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
        DATABASE_URL: mockDatabaseUrl,
        NODE_ENV: "production",
        // Use a dedicated agent WebSocket port so the capture server never collides with a
        // separately running dev server (whose instrumentation hook binds the default 3091).
        AGENT_WS_HOSTNAME: HOST,
        AGENT_WS_PORT: "39091",
        // Keep every GitHub call on the stub above; nothing reaches github.com.
        GITHUB_API_BASE_URL: mockApiURL,
        GITHUB_GRAPHQL_URL: `${mockApiURL}/graphql`,
        // Device enrollment refuses to issue a profile unless the app is served over public
        // HTTPS. The captured page only renders the form, so a placeholder origin is enough.
        PUBLIC_BASE_URL: "https://ade.acme.example.com",
        // Must match the key the seed encrypted mock.db's credentials with, or the app
        // rewrites every row on first use and the VACUUM that follows locks the database.
        CREDENTIAL_ENCRYPTION_KEY: MOCK_CREDENTIAL_ENCRYPTION_KEY,
      },
    },
  ],
});
