#!/usr/bin/env node
/**
 * Generates the runtime GraphQL schema and publishes it into the Mintlify docs project.
 * Run via:
 *
 *   npm run schema:copy               # prompts for the docs directory
 *   npm run schema:copy -- ../elsewhere
 */
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_DOCS_DIRECTORY,
  directoryExists,
  resolveDocsDirectoryPath,
  selectDocsDirectory,
} from "./docs-directory.mjs";
import { generateRuntimeSchema } from "./graphql-schema-utils.mjs";

export async function copySchema({
  docsDirectory,
  schemasDirectory = resolve(process.cwd(), "schemas"),
  cwd = process.cwd(),
} = {}) {
  const targetRoot = resolveDocsDirectoryPath(docsDirectory, cwd);
  if (!(await directoryExists(targetRoot))) {
    throw new Error(
      `Docs project not found at ${targetRoot}. Pass the directory as an argument, e.g. npm run schema:copy -- ${DEFAULT_DOCS_DIRECTORY}`,
    );
  }

  const schema = await generateRuntimeSchema(schemasDirectory);
  const targetPath = resolve(targetRoot, "schema.graphql");
  await writeFile(targetPath, schema, "utf8");
  return { schema, targetPath, targetRoot };
}

async function main() {
  const docsDirectory = await selectDocsDirectory();
  const { targetRoot } = await copySchema({ docsDirectory });
  console.log(`Copied schema.graphql into ${basename(targetRoot)}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
