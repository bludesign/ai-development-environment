// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/data/prisma-client")>();
  return { ...original, getPrismaClient };
});

import {
  MAX_RUN_ATTACHMENT_BYTES,
  cloneRunAttachments,
  runAttachmentResponse,
  storeRunAttachment,
} from "./attachment-store";

let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "aide-run-attachment-test-"));
  process.env.RUN_DATA_DIRECTORY = directory;
});

afterEach(async () => {
  delete process.env.RUN_DATA_DIRECTORY;
  await rm(directory, { recursive: true, force: true });
});

describe("run attachment storage", () => {
  test("stores a private opaque file with sanitized metadata and checksum", async () => {
    const create = vi.fn(async ({ data }) => data);
    getPrismaClient.mockResolvedValue({
      runAttachment: {
        create,
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const attachment = await storeRunAttachment(
      new Request("http://localhost/api/run-attachments", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": "5",
          "x-attachment-filename": encodeURIComponent("../unsafe/name.txt"),
        },
        body: "hello",
      }),
    );

    expect(attachment.filename).toBe("_unsafe_name.txt");
    expect(attachment.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(await readFile(attachment.storagePath, "utf8")).toBe("hello");
    expect((await stat(attachment.storagePath)).mode & 0o777).toBe(0o600);
  });

  test("rejects a declared file larger than 25 MB before writing", async () => {
    await expect(
      storeRunAttachment(
        new Request("http://localhost/api/run-attachments", {
          method: "POST",
          headers: { "content-length": String(MAX_RUN_ATTACHMENT_BYTES + 1) },
          body: "x",
        }),
      ),
    ).rejects.toThrow("25 MB");
  });

  test("refuses a database path outside the private attachment directory", async () => {
    getPrismaClient.mockResolvedValue({
      runAttachment: {
        findUnique: vi.fn().mockResolvedValue({
          id: "outside",
          filename: "outside.txt",
          contentType: "text/plain",
          size: 1,
          storagePath: join(directory, "..", "outside.txt"),
          input: null,
          draft: null,
        }),
      },
    });
    const response = await runAttachmentResponse("outside");
    expect(response.status).toBe(410);
  });

  test("clones reused attachments to independent opaque files", async () => {
    const sourcePath = join(directory, "source");
    await writeFile(sourcePath, "shared");
    const created: Array<Record<string, unknown>> = [];
    getPrismaClient.mockResolvedValue({
      runAttachment: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "source",
            sha256: "checksum",
            filename: "shared.txt",
            contentType: "text/plain",
            size: 6,
            storagePath: sourcePath,
          },
        ]),
        create: vi.fn(async ({ data }) => {
          created.push(data);
          return data;
        }),
        deleteMany: vi.fn(),
      },
    });
    const ids = await cloneRunAttachments(["source"]);
    expect(ids).toHaveLength(1);
    expect(created[0]?.storagePath).not.toBe(sourcePath);
    expect(await readFile(String(created[0]?.storagePath), "utf8")).toBe(
      "shared",
    );
  });
});
