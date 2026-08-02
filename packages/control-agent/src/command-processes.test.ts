import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const captureCommand = vi.hoisted(() => vi.fn());
vi.mock("./capture-command.js", () => ({ captureCommand }));

import {
  commandScriptPrefix,
  parseCommandProcesses,
  reapOrphanedCommandProcesses,
} from "./command-processes.js";

const capture = (stdout: string) => ({
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
});

describe("parseCommandProcesses", () => {
  test("collapses a process tree to the one group that owns it", () => {
    // The shell and anything it started share the detached group, and the
    // group is what gets signalled.
    expect(parseCommandProcesses("  4101  4101\n  4102  4101\n", 999)).toEqual([
      { pid: 4101, processGroup: 4101 },
    ]);
  });

  test("never returns a group that would signal the caller or the world", () => {
    // Group 0 means "the caller's own group" and 1 is init's; signalling
    // either would take down the agent or worse.
    expect(parseCommandProcesses("4101 0\n4102 1\n4103 4103\n", 999)).toEqual([
      { pid: 4103, processGroup: 4103 },
    ]);
  });

  test("skips the running agent even if it somehow matched", () => {
    expect(parseCommandProcesses("500 500\n501 500\n", 500)).toEqual([]);
  });

  test("ignores header rows and blank lines", () => {
    expect(parseCommandProcesses("\nPID PGID\n 4101  4101 \n", 999)).toEqual([
      { pid: 4101, processGroup: 4101 },
    ]);
  });
});

describe("reapOrphanedCommandProcesses", () => {
  const kill = vi.spyOn(process, "kill");

  beforeEach(() => {
    vi.clearAllMocks();
    kill.mockImplementation(() => true);
  });
  afterEach(() => vi.useRealTimers());

  test("matches command scripts by the path they run from", async () => {
    captureCommand.mockResolvedValue(capture(""));
    await reapOrphanedCommandProcesses("agent-1");
    expect(captureCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining([
          expect.stringContaining(commandScriptPrefix("agent-1")),
        ]),
      }),
    );
  });

  test("does nothing when no command process is left behind", async () => {
    captureCommand.mockResolvedValue(capture(""));
    await expect(reapOrphanedCommandProcesses("agent-1")).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    // Nothing matched, so there is no reason to describe processes either.
    expect(captureCommand).toHaveBeenCalledTimes(1);
  });

  test("terminates an orphaned group and then makes sure it is gone", async () => {
    vi.useFakeTimers();
    captureCommand
      .mockResolvedValueOnce(capture("4101\n4102\n"))
      .mockResolvedValueOnce(capture("4101 4101\n4102 4101\n"));

    const reaped = reapOrphanedCommandProcesses("agent-1");
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-4101, "SIGTERM"));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(reaped).resolves.toEqual([{ pid: 4101, processGroup: 4101 }]);
    expect(kill).toHaveBeenCalledWith(-4101, "SIGKILL");
    // One group, not one signal per process in it.
    expect(
      kill.mock.calls.filter(([, name]) => name === "SIGTERM"),
    ).toHaveLength(1);
  });

  test("skips the follow-up kill for a group that was already gone", async () => {
    captureCommand
      .mockResolvedValueOnce(capture("4101\n"))
      .mockResolvedValueOnce(capture("4101 4101\n"));
    kill.mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });

    await expect(reapOrphanedCommandProcesses("agent-1")).resolves.toEqual([]);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  test("starts the agent anyway when the lookup itself fails", async () => {
    captureCommand.mockRejectedValue(new Error("pgrep is missing"));
    await expect(reapOrphanedCommandProcesses("agent-1")).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  test("uses a distinct process marker for each enrolled agent", async () => {
    captureCommand.mockResolvedValue(capture(""));

    await reapOrphanedCommandProcesses("agent-1");
    await reapOrphanedCommandProcesses("agent-2");

    const patterns = captureCommand.mock.calls.map(
      ([call]) => (call as { args: string[] }).args[1],
    );
    expect(patterns[0]).toContain(commandScriptPrefix("agent-1"));
    expect(patterns[1]).toContain(commandScriptPrefix("agent-2"));
    expect(patterns[0]).not.toBe(patterns[1]);
  });
});
