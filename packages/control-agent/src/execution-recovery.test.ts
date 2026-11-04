import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureCommand } from "./capture-command.js";
import {
  forgetExecution,
  recoverExecution,
  spawnExecutionProcess,
  withExecutionJournal,
} from "./execution-recovery.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "execution-recovery-"));
  vi.stubEnv("CONTROL_AGENT_CONFIG", join(directory, "config.json"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const identity = {
  agentId: "test-agent",
  jobId: "test-job",
  executionToken: "test-execution",
};
const moduleUrl = new URL("./execution-recovery.ts", import.meta.url).href;

describe.skipIf(process.platform === "win32")(
  "execution process recovery",
  () => {
    test("does not open a pending process gate once final cleanup starts", async () => {
      const output = join(directory, "must-not-exist");
      await withExecutionJournal(identity, async (execution) => {
        const child = spawnExecutionProcess(process.execPath, [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(output)},'unsafe')`,
        ]);
        const closed = once(child, "close");
        await execution.settle();
        await closed;
      });
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("prevents inherited callbacks from starting processes after final cleanup", async () => {
      const output = join(directory, "must-not-exist");
      await withExecutionJournal(identity, async (execution) => {
        await execution.settle();
        expect(() =>
          spawnExecutionProcess(process.execPath, [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(output)},'unsafe')`,
          ]),
        ).toThrow("Cannot start a process after execution cleanup begins");
        forgetExecution(identity);
      });
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(directory, "executions"))).toEqual([]);
    });

    test("runs journaled commands and acknowledges only after their groups settle", async () => {
      const result = await withExecutionJournal(identity, () =>
        captureCommand({
          command: process.execPath,
          args: ["-e", "process.stdout.write('done')"],
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("done");
      const files = await readdir(join(directory, "executions"));
      const journal = JSON.parse(
        await readFile(join(directory, "executions", files[0]!), "utf8"),
      );
      expect(journal.state).toBe("SETTLED");
      expect(journal.groups).toHaveLength(1);
      await recoverExecution(identity);
      forgetExecution(identity);
      expect(await readdir(join(directory, "executions"))).toEqual([]);
    });

    test.each([false, true])(
      "kills verified orphan commands, including detached helpers (%s)",
      async (detached) => {
        const heartbeat = join(directory, "heartbeat");
        const ticker = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),20);`;
        const command = detached
          ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(ticker)}],{detached:true,stdio:'ignore'}).unref();`
          : ticker;
        const script = `import { withExecutionJournal, spawnExecutionProcess } from ${JSON.stringify(moduleUrl)};
      await withExecutionJournal(${JSON.stringify(identity)}, async () => {
        spawnExecutionProcess(process.execPath, ['-e', ${JSON.stringify(command)}], {stdio:['ignore','ignore','ignore']});
        setInterval(()=>{},1000);
        await new Promise(()=>{});
      });`;
        const agent = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        agent.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        try {
          await vi.waitFor(
            async () => {
              expect((await stat(heartbeat)).size, stderr).toBeGreaterThan(0);
            },
            { timeout: 10_000 },
          );
          const exited = once(agent, "exit");
          agent.kill("SIGKILL");
          await exited;
          await recoverExecution(identity);
          const size = (await stat(heartbeat)).size;
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect((await stat(heartbeat)).size).toBe(size);
          const [file] = await readdir(join(directory, "executions"));
          expect(
            JSON.parse(
              await readFile(join(directory, "executions", file!), "utf8"),
            ).state,
          ).toBe("SETTLED");
        } finally {
          agent.kill("SIGKILL");
          await recoverExecution(identity);
        }
      },
      15_000,
    );

    test("cannot start a mutator if the agent dies before recording its group", async () => {
      const output = join(directory, "must-not-exist");
      const script = `import { withExecutionJournal, spawnExecutionProcess } from ${JSON.stringify(moduleUrl)};
      await withExecutionJournal(${JSON.stringify(identity)}, async () => {
        spawnExecutionProcess(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(output)},'unsafe');`)}], {stdio:['ignore','ignore','ignore']});
        process.kill(process.pid,'SIGKILL');
      });`;
      const agent = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { env: process.env, stdio: "ignore" },
      );
      await once(agent, "exit");
      await recoverExecution(identity);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }, 15_000);
  },
);
