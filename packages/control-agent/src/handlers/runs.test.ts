import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { findClaudeSessionFile, findCodexSessionFile } from "./runs.js";

const homeDirectories: string[] = [];

async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "runs-handler-"));
  homeDirectories.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(
    homeDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session file resolution", () => {
  test("locates a Claude session by its id across project directories", async () => {
    const home = await makeHome();
    const sessionId = "edf5832e-7708-4ad5-80cd-41a317fb8c2e";
    const projectDir = join(home, ".claude", "projects", "-Users-dev-app");
    await mkdir(projectDir, { recursive: true });
    const file = join(projectDir, `${sessionId}.jsonl`);
    await writeFile(file, '{"type":"system"}\n');
    // A sibling project directory that should be skipped.
    await mkdir(join(home, ".claude", "projects", "-Users-dev-other"), {
      recursive: true,
    });

    await expect(findClaudeSessionFile(sessionId, home)).resolves.toBe(file);
    await expect(findClaudeSessionFile("missing", home)).resolves.toBeNull();
  });

  test("locates a Codex rollout whose filename ends with the thread id", async () => {
    const home = await makeHome();
    const threadId = "019f80ca-8092-7701-a01a-40a32a8ef040";
    const dayDir = join(home, ".codex", "sessions", "2026", "07", "20");
    await mkdir(dayDir, { recursive: true });
    const file = join(dayDir, `rollout-2026-07-20T14-29-42-${threadId}.jsonl`);
    await writeFile(file, '{"type":"session_meta"}\n');

    await expect(findCodexSessionFile(threadId, home)).resolves.toBe(file);
    await expect(findCodexSessionFile("019f-other", home)).resolves.toBeNull();
  });

  test("returns null when the session directories do not exist", async () => {
    const home = await makeHome();
    await expect(findClaudeSessionFile("any", home)).resolves.toBeNull();
    await expect(findCodexSessionFile("any", home)).resolves.toBeNull();
  });
});
