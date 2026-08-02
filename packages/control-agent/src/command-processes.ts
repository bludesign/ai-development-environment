import { captureCommand } from "./capture-command.js";

/**
 * Prefix of the temporary directory holding a command run's script. It is part
 * of the child's command line, which is what makes an orphan recognisable
 * later: nothing else on the machine runs a script from this path.
 */
export const COMMAND_SCRIPT_PREFIX = "aide-command-";

const SCRIPT_PATTERN = `${COMMAND_SCRIPT_PREFIX}[^/]*/command\\.sh`;
const TERMINATE_GRACE_MS = 5_000;

export type OrphanedCommandProcess = { pid: number; processGroup: number };

/**
 * Parses `pgrep`/`ps` output into the process groups that still run a command
 * script. Exported for tests; the shape is one `pid pgid` pair per line.
 */
export function parseCommandProcesses(
  output: string,
  ownPid: number,
): OrphanedCommandProcess[] {
  const groups = new Map<number, OrphanedCommandProcess>();
  for (const line of output.split("\n")) {
    const [rawPid, rawGroup] = line.trim().split(/\s+/);
    const pid = Number(rawPid);
    const processGroup = Number(rawGroup);
    if (!Number.isInteger(pid) || !Number.isInteger(processGroup)) continue;
    // Signalling group 0 means "every process in the caller's group", and
    // group 1 is init's. Neither is ever one of ours, and both would be
    // catastrophic to signal.
    if (processGroup <= 1 || pid <= 1) continue;
    if (pid === ownPid || processGroup === ownPid) continue;
    // Every process in a tree reports the same group, and the group is what
    // gets signalled. Report the leader when it is among the matches so the
    // pid names the shell that owns the tree rather than whichever child
    // happened to be listed last.
    const known = groups.get(processGroup);
    if (!known || pid === processGroup) {
      groups.set(processGroup, { pid, processGroup });
    }
  }
  return [...groups.values()];
}

async function listCommandProcesses(
  signal: AbortSignal,
): Promise<OrphanedCommandProcess[]> {
  // `pgrep -f` matches the full command line and never matches itself. Its
  // exit code is 1 when nothing matched, which is the ordinary case.
  const found = await captureCommand({
    command: "/usr/bin/pgrep",
    args: ["-f", SCRIPT_PATTERN],
    timeoutMs: 5_000,
    signal,
  });
  const pids = found.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line));
  if (!pids.length) return [];
  const described = await captureCommand({
    command: "/bin/ps",
    args: ["-o", "pid=,pgid=", "-p", pids.join(",")],
    timeoutMs: 5_000,
    signal,
  });
  return parseCommandProcesses(described.stdout, process.pid);
}

function signalGroup(processGroup: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(-processGroup, name);
    return true;
  } catch (error) {
    // ESRCH simply means the group is already gone, which is the outcome we
    // wanted. Anything else — EPERM in particular — is worth reporting.
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    console.error(
      `Could not signal orphaned command process group ${processGroup}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Terminates command run children left behind by a previous agent process.
 *
 * A command runs detached so its whole tree can be signalled as one process
 * group, which also means it outlives an agent that was killed rather than
 * asked to stop. The control plane then restarts the run, and the new attempt
 * collides with the still-running original — a server holding its port, a
 * build holding its lock.
 *
 * This must run once at startup, before any command of this agent's own is
 * spawned: every match at that moment is by definition an orphan.
 */
export async function reapOrphanedCommandProcesses(
  signal: AbortSignal = new AbortController().signal,
): Promise<OrphanedCommandProcess[]> {
  if (process.platform === "win32") return [];
  let orphans: OrphanedCommandProcess[];
  try {
    orphans = await listCommandProcesses(signal);
  } catch (error) {
    console.error(
      "Could not look for orphaned command processes:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
  const signalled = orphans.filter((orphan) =>
    signalGroup(orphan.processGroup, "SIGTERM"),
  );
  if (!signalled.length) return [];
  console.error(
    `Terminating ${signalled.length} command process(es) left by a previous agent run.`,
  );
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TERMINATE_GRACE_MS);
    timer.unref();
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  for (const orphan of signalled) signalGroup(orphan.processGroup, "SIGKILL");
  return signalled;
}
