#!/usr/bin/env node
/**
 * Publishes the desktop screenshots into the Mintlify docs project. Run via:
 *
 *   npm run screenshots:copy               # prompts for the docs directory
 *   npm run screenshots:copy -- ../elsewhere
 *
 * Only the desktop projects are copied — the docs site renders one image per theme and
 * swaps them with `dark:hidden` / `hidden dark:block`, so `desktop-light` maps onto
 * `images/light/` and `desktop-dark` onto `images/dark/`. Mobile captures stay local.
 */
import { createInterface } from "node:readline/promises";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

const DEFAULT_TARGET = "../ai-development-environment-docs";

// Playwright project -> path within the docs project that its PNGs belong in.
const PROJECT_DESTINATIONS = [
  { project: "desktop-light", destination: "images/light" },
  { project: "desktop-dark", destination: "images/dark" },
];

const sourceRoot = resolve(process.cwd(), "screenshots");

/**
 * Resolves the docs directory from the CLI argument, or asks for it when the terminal is
 * interactive. A non-interactive run (CI, a task with no stdin) takes the default rather
 * than hanging on a prompt nobody can answer.
 */
async function resolveTargetDirectory() {
  const [argument] = process.argv.slice(2);
  if (argument) return argument;
  if (!process.stdin.isTTY) return DEFAULT_TARGET;

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(
      `Docs project directory [${DEFAULT_TARGET}]: `,
    );
    return answer.trim() || DEFAULT_TARGET;
  } finally {
    readline.close();
  }
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const target = await resolveTargetDirectory();
const targetRoot = isAbsolute(target) ? target : resolve(process.cwd(), target);

// Mistyping the prompt is ordinary, not exceptional, so these exit with a readable message
// rather than a stack trace.
function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!(await directoryExists(targetRoot))) {
  fail(
    `Docs project not found at ${targetRoot}. Pass the directory as an argument, e.g. npm run screenshots:copy -- ${DEFAULT_TARGET}`,
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

  const pngs = (await readdir(sourceDirectory)).filter((name) =>
    name.endsWith(".png"),
  );
  for (const name of pngs) {
    await cp(resolve(sourceDirectory, name), resolve(targetDirectory, name));
  }

  copiedCount += pngs.length;
  console.log(`${project} -> ${destination}: ${pngs.length} PNG(s)`);
}

console.log(`Copied ${copiedCount} screenshot(s) into ${basename(targetRoot)}`);
