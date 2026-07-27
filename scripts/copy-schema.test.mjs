// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { copySchema } from "./copy-schema.mjs";
import { generateRuntimeSchema } from "./graphql-schema-utils.mjs";

const temporaryDirectories = [];
const schemasDirectory = resolve(process.cwd(), "schemas");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("schema copy", () => {
  test("writes the deterministic runtime schema into the docs root", async () => {
    const docsDirectory = await mkdtemp(join(tmpdir(), "aide-schema-copy-"));
    temporaryDirectories.push(docsDirectory);

    const first = await copySchema({ docsDirectory, schemasDirectory });
    const second = await copySchema({ docsDirectory, schemasDirectory });
    const copied = await readFile(first.targetPath, "utf8");

    expect(copied).toBe(first.schema);
    expect(second.schema).toBe(first.schema);
    expect(copied).toBe(await generateRuntimeSchema(schemasDirectory));
    expect(copied.endsWith("\n")).toBe(true);
    expect(copied).toContain("type Query");
    expect(copied).toContain("type Mutation");
    expect(copied).toContain("type Subscription");
    expect(copied).toContain("type _Service");
    expect(copied).toContain("Root query type");
  });

  test("rejects a missing docs directory without creating it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "aide-schema-missing-"));
    temporaryDirectories.push(parent);
    const docsDirectory = join(parent, "missing");

    await expect(
      copySchema({ docsDirectory, schemasDirectory }),
    ).rejects.toThrow(`Docs project not found at ${docsDirectory}`);
  });
});
