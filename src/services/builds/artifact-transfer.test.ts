import { readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import {
  cancelArtifactTransfer,
  expectArtifactTransfer,
  receiveArtifactTransfer,
  type ArtifactTransfer,
} from "./artifact-transfer";

const completed: ArtifactTransfer[] = [];

afterEach(async () => {
  await Promise.all(
    completed.splice(0).map((transfer) => rm(transfer.path, { force: true })),
  );
});

describe("build artifact transfer", () => {
  test("accepts an authenticated agent upload into a temporary file", async () => {
    const uploadId = crypto.randomUUID();
    const transferPromise = expectArtifactTransfer(uploadId, "agent-1");
    await receiveArtifactTransfer(
      uploadId,
      "agent-1",
      new Request("http://control.test/upload", {
        method: "POST",
        body: "build output",
        headers: {
          "content-length": "12",
          "content-type": "text/plain",
          "x-artifact-filename": encodeURIComponent("build.log"),
        },
      }),
    );

    const transfer = await transferPromise;
    completed.push(transfer);
    expect(transfer).toMatchObject({
      filename: "build.log",
      contentType: "text/plain",
      size: 12,
    });
    await expect(readFile(transfer.path, "utf8")).resolves.toBe("build output");
  });

  test("rejects uploads from a different agent", async () => {
    const uploadId = crypto.randomUUID();
    const transferPromise = expectArtifactTransfer(uploadId, "agent-1");
    await expect(
      receiveArtifactTransfer(
        uploadId,
        "agent-2",
        new Request("http://control.test/upload", {
          method: "POST",
          body: "not allowed",
        }),
      ),
    ).rejects.toThrow("not expected");
    cancelArtifactTransfer(uploadId, new Error("test cleanup"));
    await expect(transferPromise).rejects.toThrow("test cleanup");
  });
});
