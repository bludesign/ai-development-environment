import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getServerServices = vi.hoisted(() => vi.fn());
vi.mock("@/services/server-services", () => ({ getServerServices }));

import { GET as manifest } from "./manifest.plist/route";

const artifactForInstall = vi.fn();

function request(headers: Record<string, string> = {}): Request {
  return new Request(
    "http://127.0.0.1:3000/api/builds/build-1/artifacts/artifact-1/manifest.plist",
    { headers },
  );
}

function params() {
  return {
    params: Promise.resolve({ buildId: "build-1", artifactId: "artifact-1" }),
  };
}

function secureRequest(): Request {
  return request({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "builds.example.com",
  });
}

function ipa(metadata: Record<string, unknown> = {}) {
  return {
    id: "artifact-1",
    kind: "IPA",
    relativePath: "exports/export-1/App.ipa",
    sizeBytes: 1024,
    checksum: "checksum-1",
    createdAt: "2026-07-19T00:00:00.000Z",
    metadata: {
      exportMethod: "DEBUGGING",
      bundleIdentifier: "com.example.App",
      bundleShortVersion: "1.4.2",
      bundleVersion: "88",
      applicationName: "Example",
      ...metadata,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OTA_TOKEN_SECRET = "test-secret";
  getServerServices.mockReturnValue({
    buildsService: { artifactForInstall },
  });
});

afterEach(() => {
  delete process.env.OTA_TOKEN_SECRET;
});

describe("install manifest route", () => {
  test("serves a manifest for an exported IPA", async () => {
    artifactForInstall.mockResolvedValue(ipa());

    const response = await manifest(secureRequest(), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // Must render inline; a download disposition would break the install.
    expect(response.headers.get("content-disposition")).toBeNull();

    const body = await response.text();
    expect(body).toContain("<key>bundle-identifier</key>");
    expect(body).toContain("<string>com.example.App</string>");
    expect(body).toContain("<string>1.4.2</string>");
    expect(body).toContain("<string>Example</string>");
    expect(body).toContain("<key>kind</key><string>software</string>");
    expect(body).toContain("<string>software-package</string>");
    expect(body).toContain(
      "<string>https://builds.example.com/api/builds/build-1/artifacts/artifact-1?token=",
    );
  });

  test("honours PUBLIC_BASE_URL over the request headers", async () => {
    artifactForInstall.mockResolvedValue(ipa());
    process.env.PUBLIC_BASE_URL = "https://ota.example.com";
    try {
      const response = await manifest(secureRequest(), params());
      await expect(response.text()).resolves.toContain(
        "https://ota.example.com/api/builds/build-1/artifacts/artifact-1",
      );
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  test("falls back to the build number when no short version exists", async () => {
    artifactForInstall.mockResolvedValue(
      ipa({ bundleShortVersion: null, bundleVersion: "88" }),
    );

    const response = await manifest(secureRequest(), params());
    await expect(response.text()).resolves.toContain("<string>88</string>");
  });

  test("falls back to the bundle identifier when no app name exists", async () => {
    artifactForInstall.mockResolvedValue(ipa({ applicationName: null }));

    const body = await (await manifest(secureRequest(), params())).text();
    expect(body).toContain("<key>title</key><string>com.example.App</string>");
  });

  test("returns 404 when the artifact does not exist", async () => {
    artifactForInstall.mockResolvedValue(null);

    const response = await manifest(secureRequest(), params());
    expect(response.status).toBe(404);
  });

  test("returns 400 for a non-IPA artifact", async () => {
    artifactForInstall.mockResolvedValue({ ...ipa(), kind: "ARCHIVE" });

    const response = await manifest(secureRequest(), params());
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("IPA");
  });

  test("returns 409 for an App Store Connect export", async () => {
    artifactForInstall.mockResolvedValue(
      ipa({ exportMethod: "APP_STORE_CONNECT" }),
    );

    const response = await manifest(secureRequest(), params());
    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain("App Store Connect");
  });

  test("returns 409 when the bundle identifier is missing", async () => {
    artifactForInstall.mockResolvedValue(ipa({ bundleIdentifier: null }));

    const response = await manifest(secureRequest(), params());
    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain("bundle identifier");
  });

  test("returns 409 when the origin is not HTTPS", async () => {
    artifactForInstall.mockResolvedValue(ipa());

    const response = await manifest(
      request({ host: "127.0.0.1:3000" }),
      params(),
    );
    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain("PUBLIC_BASE_URL");
  });

  test("escapes metadata that would otherwise break the document", async () => {
    artifactForInstall.mockResolvedValue(
      ipa({ applicationName: "Ben & Jerry's <App>" }),
    );

    const body = await (await manifest(secureRequest(), params())).text();
    expect(body).toContain("Ben &amp; Jerry&apos;s &lt;App&gt;");
    expect(body).not.toContain("<App>");
  });

  test("returns 500 when the lookup fails", async () => {
    artifactForInstall.mockRejectedValue(new Error("database is down"));

    const response = await manifest(secureRequest(), params());
    expect(response.status).toBe(500);
  });
});
