import { readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getServerServices = vi.fn();
vi.mock("@/services/server-services", () => ({
  getServerServices: () => getServerServices(),
}));

import { receiveArtifactTransfer } from "./artifact-transfer";

// Isolated per process so concurrent runs cannot evict each other's entries.
const CACHE_DIRECTORY = join(
  tmpdir(),
  `ade-artifact-cache-test-${process.pid}`,
);
process.env.ARTIFACT_CACHE_DIRECTORY = CACHE_DIRECTORY;

type ArtifactRow = {
  id: string;
  kind: string;
  relativePath: string;
  sizeBytes: number | null;
  checksum: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
};

let artifactRow: ArtifactRow;
let downloads: number;
let uploadBody: string;
/** Resolves once prepareArtifactDownload has been entered, per call. */
let downloadStarted: (() => void)[];

function services() {
  return {
    buildsService: {
      artifactForInstall: vi.fn(async () => artifactRow),
      getBuild: vi.fn(async () => ({ id: "build-1", agentId: "agent-1" })),
      prepareArtifactDownload: vi.fn(
        async (
          _buildId: string,
          _artifactId: string,
          uploadId: string,
        ): Promise<void> => {
          downloads += 1;
          downloadStarted.shift()?.();
          // Stand in for the agent posting the bytes back to the control plane.
          await receiveArtifactTransfer(
            uploadId,
            "agent-1",
            new Request("http://control.test/upload", {
              method: "POST",
              body: uploadBody,
              headers: {
                "content-length": String(uploadBody.length),
                "content-type": "application/octet-stream",
                "x-artifact-filename": encodeURIComponent("App.ipa"),
              },
            }),
          );
        },
      ),
    },
  };
}

async function importCache() {
  return import("./artifact-cache");
}

beforeEach(async () => {
  vi.resetModules();
  downloads = 0;
  downloadStarted = [];
  uploadBody = "ipa-bytes";
  artifactRow = {
    id: "artifact-1",
    kind: "IPA",
    relativePath: "exports/export-1/App.ipa",
    sizeBytes: 9,
    checksum: "checksum-1",
    createdAt: "2026-07-19T00:00:00.000Z",
    metadata: {},
  };
  getServerServices.mockImplementation(services);
  await rm(CACHE_DIRECTORY, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(CACHE_DIRECTORY, { recursive: true, force: true });
});

describe("materializeArtifact", () => {
  test("transfers from the agent on a miss and serves the bytes", async () => {
    const { materializeArtifact } = await importCache();
    const artifact = await materializeArtifact("build-1", "artifact-1");

    expect(downloads).toBe(1);
    expect(artifact).toMatchObject({
      filename: "App.ipa",
      contentType: "application/octet-stream",
      size: 9,
    });
    await expect(readFile(artifact.path, "utf8")).resolves.toBe("ipa-bytes");
  });

  test("serves a second request from cache without contacting the agent", async () => {
    const { materializeArtifact } = await importCache();
    const first = await materializeArtifact("build-1", "artifact-1");
    const second = await materializeArtifact("build-1", "artifact-1");

    expect(downloads).toBe(1);
    expect(second.path).toBe(first.path);
    expect(second.etag).toBe(first.etag);
    await expect(readFile(second.path, "utf8")).resolves.toBe("ipa-bytes");
  });

  test("collapses concurrent requests into a single transfer", async () => {
    const { materializeArtifact } = await importCache();
    const entered = new Promise<void>((resolve) => {
      downloadStarted.push(resolve);
    });

    const first = materializeArtifact("build-1", "artifact-1");
    await entered;
    const second = materializeArtifact("build-1", "artifact-1");
    const [left, right] = await Promise.all([first, second]);

    expect(downloads).toBe(1);
    expect(right.path).toBe(left.path);
  });

  test("re-transfers when the checksum changes", async () => {
    const { materializeArtifact } = await importCache();
    await materializeArtifact("build-1", "artifact-1");

    artifactRow = { ...artifactRow, checksum: "checksum-2" };
    uploadBody = "new-bytes";
    artifactRow.sizeBytes = uploadBody.length;
    const updated = await materializeArtifact("build-1", "artifact-1");

    expect(downloads).toBe(2);
    await expect(readFile(updated.path, "utf8")).resolves.toBe("new-bytes");
  });

  test("falls back to createdAt when the artifact has no checksum", async () => {
    artifactRow = { ...artifactRow, checksum: null };
    const { materializeArtifact } = await importCache();
    await materializeArtifact("build-1", "artifact-1");
    await materializeArtifact("build-1", "artifact-1");

    expect(downloads).toBe(1);
  });

  test("re-transfers when the cached body no longer matches its sidecar", async () => {
    const { materializeArtifact } = await importCache();
    const artifact = await materializeArtifact("build-1", "artifact-1");

    // A truncated body must not be served as if it were complete.
    await writeFile(artifact.path, "short");
    await materializeArtifact("build-1", "artifact-1");

    expect(downloads).toBe(2);
  });

  test("re-transfers when the sidecar is missing", async () => {
    const { materializeArtifact } = await importCache();
    const artifact = await materializeArtifact("build-1", "artifact-1");

    await rm(`${artifact.path}.json`, { force: true });
    await materializeArtifact("build-1", "artifact-1");

    expect(downloads).toBe(2);
  });

  test("evicts the least recently used entries past the size budget", async () => {
    process.env.ARTIFACT_CACHE_MAX_BYTES = "12";
    try {
      vi.resetModules();
      const { materializeArtifact } = await importCache();
      const first = await materializeArtifact("build-1", "artifact-1");

      // Age the first entry so the prune sees it as least recently used.
      const old = new Date(Date.now() - 60_000);
      await utimes(first.path, old, old);

      artifactRow = { ...artifactRow, checksum: "checksum-2" };
      await materializeArtifact("build-1", "artifact-1");

      await expect(stat(first.path)).rejects.toThrow();
    } finally {
      delete process.env.ARTIFACT_CACHE_MAX_BYTES;
    }
  });

  test("rejects when the artifact does not exist", async () => {
    getServerServices.mockImplementation(() => ({
      buildsService: {
        ...services().buildsService,
        artifactForInstall: vi.fn(async () => null),
      },
    }));
    const { materializeArtifact } = await importCache();
    await expect(materializeArtifact("build-1", "missing")).rejects.toThrow(
      "not found",
    );
  });

  test("does not leave a failed transfer in flight", async () => {
    getServerServices.mockImplementation(() => ({
      buildsService: {
        ...services().buildsService,
        prepareArtifactDownload: vi.fn(async () => {
          throw new Error("Build agent is offline");
        }),
      },
    }));
    const { materializeArtifact } = await importCache();

    await expect(materializeArtifact("build-1", "artifact-1")).rejects.toThrow(
      "offline",
    );
    // A retry must be attempted rather than resolving the rejected promise again.
    await expect(materializeArtifact("build-1", "artifact-1")).rejects.toThrow(
      "offline",
    );
  });
});

describe("cache directory", () => {
  test("is created with restrictive permissions", async () => {
    const { materializeArtifact } = await importCache();
    await materializeArtifact("build-1", "artifact-1");

    const information = await stat(CACHE_DIRECTORY);
    expect(information.mode & 0o777).toBe(0o700);
  });
});
