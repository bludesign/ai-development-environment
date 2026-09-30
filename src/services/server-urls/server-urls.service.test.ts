// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test, vi } from "vitest";
const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import {
  normalizeServerOrigin,
  serverEndpointUrls,
  serverUrlOptions,
} from "@/lib/server-urls";
import { agentEventBus } from "@/services/agent-control";
import {
  ServerUrlSettingsService,
  detectServerOrigins,
  SERVER_URL_SETTINGS_CHANGED_TOPIC,
} from "./server-urls.service";

const detection = {
  localOrigins: ["http://192.168.1.2:3000"],
  publicBaseUrl: "https://aide.example.com",
};
let row: {
  id: string;
  localBaseUrlOverride: string | null;
  remoteBaseUrlOverride: string | null;
  proxyBaseUrl: string | null;
  defaultServerUrlKind: string;
  simulatorDefaultServerUrlKind: string | null;
  updatedAt: Date;
};
beforeEach(() => {
  row = {
    id: "default",
    localBaseUrlOverride: null,
    remoteBaseUrlOverride: null,
    proxyBaseUrl: null,
    defaultServerUrlKind: "LOCAL",
    simulatorDefaultServerUrlKind: null,
    updatedAt: new Date(),
  };
  const table = {
    upsert: vi.fn(async () => row),
    findUniqueOrThrow: vi.fn(async () => row),
    update: vi.fn(async ({ data }) => {
      row = { ...row, ...data };
      return row;
    }),
  };
  const prisma = {
    serverUrlSettings: table,
    $transaction: vi.fn(async (callback) => callback(prisma)),
  };
  getPrismaClient.mockResolvedValue(prisma);
});
describe("shared server URL settings", () => {
  test("preserves detection and normalizes origin-only overrides", () => {
    expect(
      detectServerOrigins({
        ...detection,
        requestOrigin: "http://10.0.0.2:3090",
      }),
    ).toEqual({
      local: "http://10.0.0.2:3090",
      remote: "https://aide.example.com",
    });
    expect(normalizeServerOrigin(" https://aide.example.com:443/// ")).toBe(
      "https://aide.example.com",
    );
    for (const value of [
      "https://aide.example.com/path",
      "https://user:password@aide.example.com",
      "https://aide.example.com/?q=1",
      "https://aide.example.com/#x",
      "file:///tmp/aide",
      "https://aide.example.com/?",
      "https://aide.example.com/#",
      "https://aide.example.com/.",
      "https://@aide.example.com",
    ])
      expect(() => normalizeServerOrigin(value)).toThrow("HTTP(S)");
  });
  test("uses Local initially and lets simulators inherit or override the global choice", async () => {
    const service = new ServerUrlSettingsService();
    expect(
      (await service.buildSettings("PHYSICAL_DEVICE", null, detection))
        .selectedUrlKind,
    ).toBe("LOCAL");
    await service.saveSettings(
      {
        proxyBaseUrl: "https://aide.ts.net/",
        defaultServerUrlKind: "REMOTE",
        simulatorDefaultServerUrlKind: "PROXY",
      },
      detection,
    );
    expect(
      (await service.buildSettings("PHYSICAL_DEVICE", null, detection))
        .selectedBaseUrl,
    ).toBe("https://aide.example.com");
    expect(
      (await service.buildSettings("SIMULATOR", null, detection))
        .selectedBaseUrl,
    ).toBe("https://aide.ts.net");
    expect(
      (await service.buildSettings("SIMULATOR", "LOCAL", detection))
        .selectedBaseUrl,
    ).toBe("http://192.168.1.2:3000");
    await service.saveSettings(
      { simulatorDefaultServerUrlKind: null },
      detection,
    );
    expect(
      (await service.buildSettings("SIMULATOR", null, detection))
        .selectedUrlKind,
    ).toBe("REMOTE");
  });
  test("rejects unavailable Proxy defaults and preserves previous settings", async () => {
    const service = new ServerUrlSettingsService();
    await expect(
      service.saveSettings({ defaultServerUrlKind: "PROXY" }, detection),
    ).rejects.toThrow("Configure a Proxy URL");
    await service.saveSettings(
      {
        proxyBaseUrl: "https://aide.ts.net",
        simulatorDefaultServerUrlKind: "PROXY",
      },
      detection,
    );
    await expect(
      service.saveSettings({ proxyBaseUrl: null }, detection),
    ).rejects.toThrow("Configure a Proxy URL");
    expect(row.proxyBaseUrl).toBe("https://aide.ts.net");
    await service.saveSettings(
      { simulatorDefaultServerUrlKind: null, proxyBaseUrl: null },
      detection,
    );
    await expect(
      service.buildSettings("SIMULATOR", "PROXY", detection),
    ).rejects.toThrow("not configured");
  });
  test("snapshots remain stable while rebuilding a retained choice resolves updated settings", async () => {
    const service = new ServerUrlSettingsService();
    await service.saveSettings(
      { proxyBaseUrl: "https://old.ts.net" },
      detection,
    );
    const first = await service.buildSettings("SIMULATOR", "PROXY", detection);
    await service.saveSettings(
      { proxyBaseUrl: "https://new.ts.net" },
      detection,
    );
    expect(first.selectedBaseUrl).toBe("https://old.ts.net");
    expect(
      (
        await service.buildSettings(
          "SIMULATOR",
          first.selectedUrlKind,
          detection,
        )
      ).selectedBaseUrl,
    ).toBe("https://new.ts.net");
  });
  test("publishes changes and derives all variants from the same path", async () => {
    const publish = vi.spyOn(agentEventBus, "publish");
    const service = new ServerUrlSettingsService();
    const settings = await service.saveSettings(
      {
        localBaseUrlOverride: "http://localhost:3090",
        proxyBaseUrl: "https://proxy.ts.net",
      },
      detection,
    );
    expect(publish).toHaveBeenCalledWith(SERVER_URL_SETTINGS_CHANGED_TOPIC, {
      updatedAt: row.updatedAt.toISOString(),
    });
    expect(serverEndpointUrls(settings, "/api/public/sse/secret")).toEqual({
      localUrl: "http://localhost:3090/api/public/sse/secret",
      remoteUrl: "https://aide.example.com/api/public/sse/secret",
      proxyUrl: "https://proxy.ts.net/api/public/sse/secret",
    });
    expect(
      serverUrlOptions({ ...settings, proxyBaseUrl: null }).map(
        (value) => value.kind,
      ),
    ).toEqual(["LOCAL", "REMOTE"]);
  });
  test("migrates existing overrides without changing collection settings", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE TelemetrySettings (id TEXT PRIMARY KEY, localBaseUrlOverride TEXT, remoteBaseUrlOverride TEXT, consoleCollectionEnabled BOOLEAN, createdAt DATETIME, updatedAt DATETIME); INSERT INTO TelemetrySettings VALUES ('default', 'http://localhost:3090', 'https://aide.example.com', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);`,
      );
      db.exec(
        readFileSync(
          "prisma/migrations/20261002100000_shared_server_urls/migration.sql",
          "utf8",
        ),
      );
      expect(
        db
          .prepare(
            "SELECT localBaseUrlOverride, remoteBaseUrlOverride, defaultServerUrlKind, simulatorDefaultServerUrlKind FROM ServerUrlSettings",
          )
          .get(),
      ).toMatchObject({
        localBaseUrlOverride: "http://localhost:3090",
        remoteBaseUrlOverride: "https://aide.example.com",
        defaultServerUrlKind: "LOCAL",
        simulatorDefaultServerUrlKind: null,
      });
      expect(
        db
          .prepare("SELECT consoleCollectionEnabled FROM TelemetrySettings")
          .get(),
      ).toMatchObject({ consoleCollectionEnabled: 0 });
    } finally {
      db.close();
    }
  });
});
