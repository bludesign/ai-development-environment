// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_DOCS_DIRECTORY,
  directoryExists,
  resolveDocsDirectoryPath,
  selectDocsDirectory,
} from "./docs-directory.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("docs directory selection", () => {
  test("uses an explicit argument without prompting", async () => {
    expect(await selectDocsDirectory({ argument: "../custom-docs" })).toBe(
      "../custom-docs",
    );
  });

  test("uses the shared default outside an interactive terminal", async () => {
    const input = new PassThrough();
    expect(await selectDocsDirectory({ argument: undefined, input })).toBe(
      DEFAULT_DOCS_DIRECTORY,
    );
  });

  test("prompts interactively and accepts both an answer and a blank default", async () => {
    for (const [answer, expected] of [
      ["../prompted-docs\n", "../prompted-docs"],
      ["\n", DEFAULT_DOCS_DIRECTORY],
    ]) {
      const input = new PassThrough();
      input.isTTY = true;
      input.end(answer);
      const output = new PassThrough();

      expect(
        await selectDocsDirectory({ argument: undefined, input, output }),
      ).toBe(expected);
    }
  });

  test("resolves relative paths and identifies existing directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aide-docs-directory-"));
    temporaryDirectories.push(directory);

    expect(resolveDocsDirectoryPath("docs", directory)).toBe(
      resolve(directory, "docs"),
    );
    expect(await directoryExists(directory)).toBe(true);
    expect(await directoryExists(join(directory, "missing"))).toBe(false);
  });
});
