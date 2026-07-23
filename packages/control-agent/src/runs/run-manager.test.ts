import { describe, expect, test, vi } from "vitest";

import type { RunCommand } from "../graphql-client.js";
import { RunManager } from "./run-manager.js";

function command(id: string, type: string): RunCommand {
  return {
    id,
    runId: "run-1",
    agentId: "agent-1",
    sequence: type === "CANCEL" ? 1 : 0,
    type,
    payload: {},
    status: "QUEUED",
    error: null,
    run: { id: "run-1" },
  } as unknown as RunCommand;
}

describe("RunManager command priority", () => {
  test("runs cancellation without waiting for the active run command", async () => {
    let releaseStart!: () => void;
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const manager = new RunManager({} as never);
    const testable = manager as unknown as {
      runCommand: (value: RunCommand, startup: boolean) => Promise<void>;
      interruptionRequests: Map<string, "PAUSED" | "CANCELLED">;
    };
    testable.runCommand = vi.fn(async (value) => {
      calls.push(value.type);
      if (value.type === "CONTINUE") await startBlocked;
    });

    manager.execute(command("continue-1", "CONTINUE"));
    await vi.waitFor(() => expect(calls).toEqual(["CONTINUE"]));

    manager.execute(command("cancel-1", "CANCEL"));
    await vi.waitFor(() => expect(calls).toEqual(["CONTINUE", "CANCEL"]));
    expect(testable.interruptionRequests.get("run-1")).toBe("CANCELLED");

    releaseStart();
    await vi.waitFor(() =>
      expect(testable.interruptionRequests.has("run-1")).toBe(false),
    );
  });
});
