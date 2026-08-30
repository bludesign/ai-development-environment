import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
const cacheTransferredArtifact = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
vi.mock("./artifact-cache", () => ({ cacheTransferredArtifact }));

type Transfer = {
  id: string;
  artifactId: string;
  sourceAgentId: string;
  targetAgentId: string;
  status: string;
  uploadOffset: number;
  uploadLength: number | null;
  downloadOffset: number;
  checksum: string | null;
  filename: string | null;
  contentType: string | null;
  stagingPath: string | null;
  error: string | null;
  expiresAt: Date;
  finishedAt: Date | null;
  artifact: { id: string; buildId: string; build: { id: string } };
};

let directory: string;
let transfer: Transfer;
let update: ReturnType<typeof vi.fn>;

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function relay() {
  return import("./artifact-relay");
}

beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(join(tmpdir(), "artifact-relay-test-"));
  process.env.ARTIFACT_TRANSFER_DIRECTORY = directory;
  transfer = {
    id: "transfer-1",
    artifactId: "artifact-1",
    sourceAgentId: "source-agent",
    targetAgentId: "target-agent",
    status: "QUEUED",
    uploadOffset: 0,
    uploadLength: null,
    downloadOffset: 0,
    checksum: null,
    filename: null,
    contentType: null,
    stagingPath: null,
    error: null,
    expiresAt: new Date(Date.now() + 60_000),
    finishedAt: null,
    artifact: {
      id: "artifact-1",
      buildId: "build-1",
      build: { id: "build-1" },
    },
  };
  update = vi.fn(async ({ data }: { data: Partial<Transfer> }) => {
    transfer = { ...transfer, ...data };
    return transfer;
  });
  getPrismaClient.mockResolvedValue({
    buildArtifactTransfer: {
      findUnique: vi.fn(async () => transfer),
      findFirst: vi.fn(async () => transfer),
      update,
    },
    buildDeployment: { updateMany: vi.fn() },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
  });
  cacheTransferredArtifact.mockImplementation(async (input) => ({
    path: input.path,
    filename: input.filename,
    contentType: input.contentType,
    size: (await stat(input.path)).size,
    etag: '"artifact-1"',
  }));
});

afterEach(async () => {
  delete process.env.ARTIFACT_TRANSFER_DIRECTORY;
  await rm(directory, { recursive: true, force: true });
});

describe("build artifact relay", () => {
  test("retries positioned writes until the complete chunk is stored", async () => {
    const { writeArtifactTransferBytes } = await relay();
    const positions: number[] = [];
    const stored: number[] = [];
    const writer = {
      write: vi.fn(
        async (
          bytes: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          positions.push(position);
          stored.push(bytes[offset]!);
          return { bytesWritten: Math.min(1, length) };
        },
      ),
    };

    await writeArtifactTransferBytes(writer, Buffer.from("abc"), 7);

    expect(positions).toEqual([7, 8, 9]);
    expect(Buffer.from(stored).toString()).toBe("abc");
  });

  test("rejects a positioned write that makes no progress", async () => {
    const { writeArtifactTransferBytes } = await relay();

    await expect(
      writeArtifactTransferBytes(
        { write: vi.fn().mockResolvedValue({ bytesWritten: 0 }) },
        Buffer.from("abc"),
        0,
      ),
    ).rejects.toThrow("made no progress");
  });

  test("enforces agent identity and expires unfinished transfers", async () => {
    const { buildArtifactTransferStatus } = await relay();

    await expect(
      buildArtifactTransferStatus("transfer-1", "other-agent"),
    ).rejects.toThrow("another agent");

    transfer.expiresAt = new Date(Date.now() - 1);
    await expect(
      buildArtifactTransferStatus("transfer-1", "source-agent"),
    ).resolves.toMatchObject({ status: "EXPIRED" });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXPIRED" }),
      }),
    );
  });

  test("resumes uploads from the confirmed offset and serves verified ranges", async () => {
    const {
      appendBuildArtifactTransferChunk,
      completeBuildArtifactTransferUpload,
      initializeBuildArtifactTransfer,
      readBuildArtifactTransferRange,
    } = await relay();
    const metadata = {
      uploadLength: 3,
      checksum: checksum("abc"),
      filename: "Acme.app.tar.gz",
      contentType: "application/gzip",
    };

    await initializeBuildArtifactTransfer(
      "transfer-1",
      "source-agent",
      metadata,
    );
    await appendBuildArtifactTransferChunk(
      "transfer-1",
      "source-agent",
      0,
      Buffer.from("a"),
    );
    await expect(
      appendBuildArtifactTransferChunk(
        "transfer-1",
        "source-agent",
        0,
        Buffer.from("b"),
      ),
    ).rejects.toThrow("expected 1");

    const resumed = await initializeBuildArtifactTransfer(
      "transfer-1",
      "source-agent",
      metadata,
    );
    expect(resumed.uploadOffset).toBe(1);
    await appendBuildArtifactTransferChunk(
      "transfer-1",
      "source-agent",
      1,
      Buffer.from("bc"),
    );
    await expect(
      completeBuildArtifactTransferUpload("transfer-1", "source-agent"),
    ).resolves.toMatchObject({ status: "READY", uploadOffset: 3 });

    await expect(
      readBuildArtifactTransferRange("transfer-1", "source-agent", 0, 2),
    ).rejects.toThrow("another agent");
    const range = await readBuildArtifactTransferRange(
      "transfer-1",
      "target-agent",
      0,
      2,
    );
    expect(range.bytes.toString()).toBe("abc");
    expect(transfer).toMatchObject({
      status: "DOWNLOADING",
      downloadOffset: 3,
    });
  });

  test("rejects oversized chunks and fails a checksum mismatch", async () => {
    const {
      ARTIFACT_TRANSFER_CHUNK_BYTES,
      appendBuildArtifactTransferChunk,
      completeBuildArtifactTransferUpload,
      initializeBuildArtifactTransfer,
    } = await relay();
    await initializeBuildArtifactTransfer("transfer-1", "source-agent", {
      uploadLength: ARTIFACT_TRANSFER_CHUNK_BYTES + 1,
      checksum: checksum("different"),
      filename: "Acme.app.tar.gz",
      contentType: "application/gzip",
    });
    await expect(
      appendBuildArtifactTransferChunk(
        "transfer-1",
        "source-agent",
        0,
        Buffer.alloc(ARTIFACT_TRANSFER_CHUNK_BYTES + 1),
      ),
    ).rejects.toThrow("1 to 16 MiB");

    transfer.uploadLength = 3;
    await appendBuildArtifactTransferChunk(
      "transfer-1",
      "source-agent",
      0,
      Buffer.from("abc"),
    );
    await expect(
      completeBuildArtifactTransferUpload("transfer-1", "source-agent"),
    ).rejects.toThrow("checksum did not match");
    expect(transfer).toMatchObject({ status: "FAILED", stagingPath: null });
  });
});
