// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  APOLLO_GRAPH_REF,
  APOLLO_SUBGRAPH_NAME,
  publishSchema,
} from "./publish-schema.mjs";

const temporaryDirectories = [];
const schemasDirectory = resolve(process.cwd(), "schemas");

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("schema publishing", () => {
  test("loads APOLLO_KEY from .env and publishes a temporary runtime schema", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aide-schema-publish-test-"));
    temporaryDirectories.push(cwd);
    await writeFile(join(cwd, ".env"), 'APOLLO_KEY="service:test-key"\n');

    let invocation;
    const result = await publishSchema({
      cwd,
      schemasDirectory,
      environment: {},
      run: async (args, environment) => {
        const schemaPath = args[args.indexOf("--schema") + 1];
        invocation = {
          args,
          apolloKey: environment.APOLLO_KEY,
          schema: await readFile(schemaPath, "utf8"),
        };
      },
    });

    expect(invocation.apolloKey).toBe("service:test-key");
    expect(invocation.args).toEqual([
      "subgraph",
      "publish",
      APOLLO_GRAPH_REF,
      "--schema",
      result.schemaPath,
      "--name",
      APOLLO_SUBGRAPH_NAME,
      "--no-url",
    ]);
    expect(invocation.schema).toContain("type Query");
    expect(invocation.schema).toContain("type _Service");
    expect(await pathExists(result.schemaPath)).toBe(false);
  });

  test("fails before generating a schema when APOLLO_KEY is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aide-schema-key-test-"));
    temporaryDirectories.push(cwd);

    await expect(
      publishSchema({ cwd, schemasDirectory, environment: {} }),
    ).rejects.toThrow("APOLLO_KEY is not configured");
  });
});
