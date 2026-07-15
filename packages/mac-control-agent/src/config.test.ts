import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, saveConfig, type AgentConfig } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("agent configuration", () => {
  test("writes development credentials with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mac-control-agent-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "nested", "config.json");
    const config: AgentConfig = {
      server: "http://127.0.0.1:3000",
      websocketServer: "ws://127.0.0.1:3092/graphql",
      agentId: "agent-test",
      credential: "credential-test",
      name: "test-dev",
    };

    await saveConfig(config, path);

    expect(await loadConfig(path)).toEqual(config);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
