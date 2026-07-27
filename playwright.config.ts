import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.SCREENSHOT_PORT ?? "4321";
const HOST = "127.0.0.1";
const baseURL = `http://${HOST}:${PORT}`;

// Absolute file URL so the standalone server resolves the same database regardless of its CWD.
const mockDatabaseUrl = `file:${path.resolve(process.cwd(), "prisma/mock.db")}`;

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

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
        colorScheme: "light",
      },
    },
    {
      name: "desktop-dark",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP_VIEWPORT,
        colorScheme: "dark",
      },
    },
    {
      name: "mobile-light",
      use: { ...devices["iPhone 13"], colorScheme: "light" },
    },
    {
      name: "mobile-dark",
      use: { ...devices["iPhone 13"], colorScheme: "dark" },
    },
  ],
  webServer: {
    command: `node_modules/.bin/next start -p ${PORT} -H ${HOST}`,
    url: `${baseURL}/en`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: ".next-mock",
      DATABASE_URL: mockDatabaseUrl,
      NODE_ENV: "production",
      // Use a dedicated agent WebSocket port so the capture server never collides with a
      // separately running dev server (whose instrumentation hook binds the default 3091).
      AGENT_WS_HOSTNAME: HOST,
      AGENT_WS_PORT: "39091",
    },
  },
});
