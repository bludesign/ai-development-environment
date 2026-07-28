#!/usr/bin/env node
/**
 * Publishes the generated runtime schema to Apollo GraphOS. APOLLO_KEY is read from the
 * current environment or the repository's ignored .env file and is never passed as a
 * command-line argument.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { generateRuntimeSchema } from "./graphql-schema-utils.mjs";

const require = createRequire(import.meta.url);
const { parse: parseEnv } = require("dotenv");

export const APOLLO_GRAPH_REF = "ai-development-environment@current";
export const APOLLO_SUBGRAPH_NAME = "ai-development-environment";

async function readApolloKey(cwd, environment) {
  if (environment.APOLLO_KEY?.trim()) return environment.APOLLO_KEY.trim();

  let envFile;
  try {
    envFile = await readFile(resolve(cwd, ".env"), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const key = envFile ? parseEnv(envFile).APOLLO_KEY?.trim() : undefined;
  if (!key) {
    throw new Error(
      "APOLLO_KEY is not configured. Add it to .env or the command environment before publishing the schema.",
    );
  }
  return key;
}

function runRover(args, environment) {
  const roverPath = require.resolve("@apollo/rover/bin/rover.js");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [roverPath, ...args], {
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(
          new Error(
            signal
              ? `Rover was terminated by ${signal}.`
              : `Rover exited with status ${code ?? "unknown"}.`,
          ),
        );
      }
    });
  });
}

export async function publishSchema({
  cwd = process.cwd(),
  schemasDirectory = resolve(cwd, "schemas"),
  environment = process.env,
  run = runRover,
} = {}) {
  const apolloKey = await readApolloKey(cwd, environment);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "aide-schema-publish-"),
  );
  const schemaPath = join(temporaryDirectory, "schema.graphql");

  try {
    await writeFile(
      schemaPath,
      await generateRuntimeSchema(schemasDirectory),
      "utf8",
    );
    const args = [
      "subgraph",
      "publish",
      APOLLO_GRAPH_REF,
      "--schema",
      schemaPath,
      "--name",
      APOLLO_SUBGRAPH_NAME,
      "--no-url",
    ];
    await run(args, { ...environment, APOLLO_KEY: apolloKey });
    return { args, schemaPath };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  await publishSchema();
  console.log(
    `Published ${APOLLO_SUBGRAPH_NAME} to ${APOLLO_GRAPH_REF} without a routing URL.`,
  );
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
