import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export const DEFAULT_DOCS_DIRECTORY = "../ai-development-environment-docs";

/**
 * Returns an explicit docs directory, prompts in an interactive terminal, or uses the
 * shared default for non-interactive commands.
 */
export async function selectDocsDirectory({
  argument = process.argv.slice(2)[0],
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (argument) return argument;
  if (!input.isTTY) return DEFAULT_DOCS_DIRECTORY;

  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(
      `Docs project directory [${DEFAULT_DOCS_DIRECTORY}]: `,
    );
    return answer.trim() || DEFAULT_DOCS_DIRECTORY;
  } finally {
    readline.close();
  }
}

export function resolveDocsDirectoryPath(directory, cwd = process.cwd()) {
  return isAbsolute(directory) ? directory : resolve(cwd, directory);
}

export async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
