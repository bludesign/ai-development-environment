#!/usr/bin/env node
/**
 * Publishes the desktop screenshots into the Mintlify docs project. Run via:
 *
 *   npm run screenshots:copy               # prompts for the docs directory
 *   npm run screenshots:copy -- ../elsewhere
 *
 * Only the desktop projects are copied — the docs site renders one asset per theme and
 * swaps them with `dark:hidden` / `hidden dark:block`, so `desktop-light` maps onto
 * `images/light/` and `desktop-dark` onto `images/dark/`. Mobile captures stay local.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  DEFAULT_DOCS_DIRECTORY,
  directoryExists,
  resolveDocsDirectoryPath,
  selectDocsDirectory,
} from "./docs-directory.mjs";

// Playwright project -> path within the docs project that its captures belong in.
const PROJECT_DESTINATIONS = [
  { project: "desktop-light", destination: "images/light" },
  { project: "desktop-dark", destination: "images/dark" },
];

// The route stills are PNGs; the walkthrough screencast from walkthrough.spec.ts is a WebM.
// Both live in the same per-theme directory, and the docs pages pick whichever they need.
const PUBLISHED_EXTENSIONS = [".png", ".webm"];

const sourceRoot = resolve(process.cwd(), "screenshots");

const target = await selectDocsDirectory();
const targetRoot = resolveDocsDirectoryPath(target);

// Mistyping the prompt is ordinary, not exceptional, so these exit with a readable message
// rather than a stack trace.
function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!(await directoryExists(targetRoot))) {
  fail(
    `Docs project not found at ${targetRoot}. Pass the directory as an argument, e.g. npm run screenshots:copy -- ${DEFAULT_DOCS_DIRECTORY}`,
  );
}

for (const { project } of PROJECT_DESTINATIONS) {
  if (!(await directoryExists(resolve(sourceRoot, project)))) {
    fail(
      `No ${project} screenshots in ${sourceRoot}. Run \`npm run screenshots\` first.`,
    );
  }
}

let copiedCount = 0;
for (const { project, destination } of PROJECT_DESTINATIONS) {
  const sourceDirectory = resolve(sourceRoot, project);
  const targetDirectory = resolve(targetRoot, destination);
  await mkdir(targetDirectory, { recursive: true });

  const captures = (await readdir(sourceDirectory)).filter((name) =>
    PUBLISHED_EXTENSIONS.some((extension) => name.endsWith(extension)),
  );
  for (const name of captures) {
    await cp(resolve(sourceDirectory, name), resolve(targetDirectory, name));
  }

  copiedCount += captures.length;
  console.log(`${project} -> ${destination}: ${captures.length} file(s)`);
}

console.log(`Copied ${copiedCount} capture(s) into ${basename(targetRoot)}`);
