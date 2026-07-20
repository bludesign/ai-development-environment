import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const materializeArtifact = vi.hoisted(() => vi.fn());
vi.mock("@/services/builds/artifact-cache", () => ({ materializeArtifact }));

import { signArtifactToken } from "@/lib/artifact-token";

import { GET, HEAD } from "./route";

const BODY = "0123456789abcdef";
const roots: string[] = [];

function params() {
  return {
    params: Promise.resolve({ buildId: "build-1", artifactId: "artifact-1" }),
  };
}

function request(headers: Record<string, string> = {}, query = ""): Request {
  return new Request(
    `http://127.0.0.1:3000/api/builds/build-1/artifacts/artifact-1${query}`,
    { headers },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.OTA_TOKEN_SECRET = "test-secret";
  const root = await mkdtemp(join(tmpdir(), "ade-artifact-route-"));
  roots.push(root);
  const path = join(root, "App.ipa");
  await writeFile(path, BODY);
  materializeArtifact.mockResolvedValue({
    path,
    filename: "App.ipa",
    contentType: "application/octet-stream",
    size: BODY.length,
    etag: '"abc123"',
  });
});

afterEach(async () => {
  delete process.env.OTA_TOKEN_SECRET;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("artifact download route", () => {
  test("serves the whole artifact", async () => {
    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(BODY.length));
    expect(response.headers.get("etag")).toBe('"abc123"');
    expect(response.headers.get("content-disposition")).toContain(
      'filename="App.ipa"',
    );
    await expect(response.text()).resolves.toBe(BODY);
  });

  test("serves a byte range", async () => {
    const response = await GET(request({ range: "bytes=0-3" }), params());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 0-3/${BODY.length}`,
    );
    expect(response.headers.get("content-length")).toBe("4");
    await expect(response.text()).resolves.toBe("0123");
  });

  test("serves an open ended range through the final byte", async () => {
    const response = await GET(request({ range: "bytes=10-" }), params());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 10-15/${BODY.length}`,
    );
    await expect(response.text()).resolves.toBe("abcdef");
  });

  test("serves a suffix range", async () => {
    const response = await GET(request({ range: "bytes=-4" }), params());

    expect(response.status).toBe(206);
    await expect(response.text()).resolves.toBe("cdef");
  });

  test("rejects a range past the end with 416", async () => {
    const response = await GET(request({ range: "bytes=99-" }), params());

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(
      `bytes */${BODY.length}`,
    );
  });

  test("falls back to the whole body for a multi-range request", async () => {
    const response = await GET(request({ range: "bytes=0-3,8-11" }), params());

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(BODY);
  });

  test("answers HEAD with headers and no body", async () => {
    const response = await HEAD(request(), params());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(BODY.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    await expect(response.text()).resolves.toBe("");
  });

  test("answers a ranged HEAD without a body", async () => {
    const response = await HEAD(request({ range: "bytes=0-3" }), params());

    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("4");
    await expect(response.text()).resolves.toBe("");
  });

  test("accepts a valid signed link", async () => {
    const { token, expires } = signArtifactToken("artifact-1");
    const response = await GET(
      request({}, `?token=${token}&expires=${expires}`),
      params(),
    );

    expect(response.status).toBe(200);
  });

  test("rejects an expired signed link", async () => {
    const expiresAt = Date.now() - 1_000;
    const { token } = signArtifactToken("artifact-1", expiresAt);
    const response = await GET(
      request({}, `?token=${token}&expires=${expiresAt}`),
      params(),
    );

    expect(response.status).toBe(403);
    expect(materializeArtifact).not.toHaveBeenCalled();
  });

  test("rejects a forged token", async () => {
    const response = await GET(
      request({}, `?token=forged&expires=${Date.now() + 60_000}`),
      params(),
    );

    expect(response.status).toBe(403);
  });

  test("still serves links that carry no token", async () => {
    const response = await GET(request(), params());
    expect(response.status).toBe(200);
  });

  test("maps a missing artifact to 404", async () => {
    materializeArtifact.mockRejectedValue(
      new Error("Build artifact not found"),
    );

    const response = await GET(request(), params());
    expect(response.status).toBe(404);
  });

  test("maps an offline agent to 409", async () => {
    materializeArtifact.mockRejectedValue(new Error("Build agent is offline"));

    const response = await GET(request(), params());
    expect(response.status).toBe(409);
  });

  test("maps an unexpected failure to 500", async () => {
    materializeArtifact.mockRejectedValue(new Error("disk exploded"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const response = await GET(request(), params());
    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });
});
