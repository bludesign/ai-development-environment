import { AsyncLocalStorage } from "node:async_hooks";
import {
  spawn as nativeSpawn,
  execFileSync,
  type SpawnOptions,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "./config.js";

type ExecutionIdentity = {
  agentId: string;
  jobId: string;
  executionToken: string;
};
type ExecutionJournal = ExecutionIdentity & {
  version: 1;
  state: "RUNNING" | "SETTLED";
  marker: string;
  groups: number[];
};
const executions = new AsyncLocalStorage<ExecutionJournal>();
export function executionEnvironment(): Record<string, string> {
  const journal = executions.getStore();
  return journal ? { AIDE_EXECUTION_MARKER: journal.marker } : {};
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const journalPath = (identity: ExecutionIdentity) =>
  join(
    dirname(configPath()),
    "executions",
    `${digest(`${identity.agentId}\0${identity.jobId}\0${identity.executionToken}`)}.json`,
  );

function persist(journal: ExecutionJournal): void {
  const path = journalPath(journal);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(journal)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

// No user command can run until its process group is durably recorded. If the
// agent dies before START, IPC disconnect exits this gate without spawning it.
const PROCESS_GATE = `
import { spawn } from 'node:child_process';
const [marker, command, serializedArgs] = process.argv.slice(2);
let started = false;
process.on('disconnect', () => { if (!started) process.exit(0); });
process.once('message', () => {
  started = true;
  const child = spawn(command, JSON.parse(serializedArgs), { stdio: ['inherit', 'inherit', 'inherit'], env: process.env, shell: false });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 127; process.disconnect?.(); });
  child.once('close', (code, signal) => {
    if (signal) { try { process.kill(process.pid, signal); } catch { process.exitCode = 1; } }
    else process.exitCode = code ?? 1;
    process.disconnect?.();
  });
});
`;

function processGatePath(): string {
  const path = join(dirname(configPath()), "process-gate.mjs");
  try {
    if (readFileSync(path, "utf8") === PROCESS_GATE) return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, PROCESS_GATE, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}

/** Native spawn outside a granted job; a journaled process-group gate inside. */
export const spawnExecutionProcess: typeof nativeSpawn = ((
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
) => {
  const journal = executions.getStore();
  if (!journal) return nativeSpawn(command, args, options);
  if (options.shell)
    throw new Error(
      "Execution recovery requires an explicit command interpreter",
    );
  const baseStdio = Array.isArray(options.stdio)
    ? options.stdio.slice(0, 3)
    : [
        options.stdio ?? "pipe",
        options.stdio ?? "pipe",
        options.stdio ?? "pipe",
      ];
  const child = nativeSpawn(
    process.execPath,
    [
      processGatePath(),
      `aide-execution:${journal.marker}`,
      command,
      JSON.stringify(args),
    ],
    {
      ...options,
      detached: process.platform !== "win32",
      env: {
        ...(options.env ?? process.env),
        AIDE_EXECUTION_MARKER: journal.marker,
      },
      stdio: [...baseStdio, "ipc"] as SpawnOptions["stdio"],
    },
  );
  const nativeKill = child.kill.bind(child);
  let wasSignalled = false;
  child.kill = (signal: NodeJS.Signals | number = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null)
      return nativeKill(signal);
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        wasSignalled = true;
        nativeKill(signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return nativeKill(signal);
  };
  child.once("spawn", () => {
    if (!child.pid || child.killed || wasSignalled) return;
    try {
      journal.groups.push(child.pid);
      persist(journal);
      child.send?.({ start: true }, (error) => {
        if (error) child.kill("SIGTERM");
      });
    } catch (error) {
      // The gate has not received START, so failure cannot leave a mutator.
      child.kill("SIGTERM");
      child.emit(
        "error",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
  return child;
}) as typeof nativeSpawn;

type ProcessEntry = {
  pid: number;
  group: number;
  state: string;
  command: string;
};

function processTable(environment = false): ProcessEntry[] {
  const args = environment
    ? ["eww", "-axo", "pid=,pgid=,stat=,command="]
    : ["-ww", "-axo", "pid=,pgid=,stat=,command="];
  const output = execFileSync("/bin/ps", args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            group: Number(match[2]),
            state: match[3]!,
            command: match[4]!,
          },
        ]
      : [];
  });
}

function liveMembers(group: number): ProcessEntry[] {
  return processTable().filter(
    (entry) => entry.group === group && !entry.state.startsWith("Z"),
  );
}

function verifiedGroup(
  group: number,
  marker: string,
  members: ProcessEntry[],
): boolean {
  const leader = members.find((entry) => entry.pid === group);
  if (leader?.command.includes(`aide-execution:${marker}`)) return true;
  const marked = processTable(true).filter(
    (entry) =>
      entry.group === group &&
      entry.command.includes(`AIDE_EXECUTION_MARKER=${marker}`),
  );
  return leader
    ? marked.some((entry) => entry.pid === leader.pid)
    : marked.length > 0 &&
        members.every((member) =>
          marked.some((entry) => entry.pid === member.pid),
        );
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });

async function cleanupGroups(
  journal: ExecutionJournal,
  signal?: AbortSignal,
): Promise<void> {
  const groups = new Set(journal.groups);
  const ownGroup =
    process.platform !== "win32"
      ? processTable().find((entry) => entry.pid === process.pid)?.group
      : process.pid;
  // Hooks and build tools may detach a helper into another process group.
  // The inherited marker keeps that descendant tied to its execution grant.
  if (process.platform !== "win32") {
    for (const entry of processTable(true)) {
      if (entry.command.includes(`AIDE_EXECUTION_MARKER=${journal.marker}`))
        groups.add(entry.group);
    }
  }
  for (const group of groups) {
    if (
      !Number.isSafeInteger(group) ||
      group <= 1 ||
      group === process.pid ||
      group === ownGroup
    )
      throw new Error(
        "Invalid execution process group; cleanup could not be verified",
      );
    if (process.platform === "win32")
      throw new Error(
        "Interrupted process cleanup requires verification on this platform; the execution claim remains protected",
      );
    let members = liveMembers(group);
    if (!members.length) continue;
    const leader = members.find((entry) => entry.pid === group);
    if (!verifiedGroup(group, journal.marker, members)) {
      // A different leader proves that the original group ended and its id was
      // reused. Never signal that unrelated process.
      if (leader && journal.groups.includes(group)) continue;
      throw new Error(
        `Execution cleanup is not verified for process group ${group}; stop the original processes and recovery will retry`,
      );
    }
    try {
      process.kill(-group, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const grace = Date.now() + 2_000;
    while (
      (members = liveMembers(group)).length &&
      Date.now() < grace &&
      !signal?.aborted
    )
      await delay(25, signal);
    if (members.length) {
      // Verify identity again before escalation; a PID can be reused meanwhile.
      if (!verifiedGroup(group, journal.marker, members))
        throw new Error(
          `Execution process group ${group} changed identity before cleanup completed`,
        );
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const deadline = Date.now() + 3_000;
    while (liveMembers(group).length) {
      if (signal?.aborted || Date.now() >= deadline)
        throw new Error(
          `Execution process group ${group} is still active; its claim remains protected`,
        );
      await delay(25, signal);
    }
  }
}

export async function withExecutionJournal<T>(
  identity: ExecutionIdentity,
  task: () => Promise<T>,
): Promise<T> {
  const journal: ExecutionJournal = {
    ...identity,
    version: 1,
    state: "RUNNING",
    marker: digest(identity.executionToken),
    groups: [],
  };
  persist(journal);
  try {
    return await executions.run(journal, task);
  } finally {
    await cleanupGroups(journal);
    journal.state = "SETTLED";
    persist(journal);
  }
}

/** Prove interrupted commands are gone before acknowledging their server grant. */
export async function recoverExecution(
  identity: ExecutionIdentity,
  signal?: AbortSignal,
): Promise<void> {
  let journal: ExecutionJournal;
  try {
    journal = JSON.parse(
      readFileSync(journalPath(identity), "utf8"),
    ) as ExecutionJournal;
  } catch (error) {
    // START is sent only after the journal exists and is fsynced. An interrupted
    // grant without a journal has not started a user command.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      "Execution journal cannot be read; its claim remains protected",
    );
  }
  if (
    journal.version !== 1 ||
    journal.agentId !== identity.agentId ||
    journal.jobId !== identity.jobId ||
    journal.executionToken !== identity.executionToken ||
    journal.marker !== digest(identity.executionToken) ||
    !Array.isArray(journal.groups)
  )
    throw new Error(
      "Execution journal identity is invalid; its claim remains protected",
    );
  if (journal.state !== "SETTLED") {
    await cleanupGroups(journal, signal);
    journal.state = "SETTLED";
    persist(journal);
  }
}

export function forgetExecution(identity: ExecutionIdentity): void {
  try {
    rmSync(journalPath(identity), { force: true });
  } catch (error) {
    console.error(
      "Could not remove a settled execution journal:",
      error instanceof Error ? error.message : error,
    );
  }
}
