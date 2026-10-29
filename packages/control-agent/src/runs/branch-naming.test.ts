import { afterEach, expect, test, vi } from "vitest";
import { generateBranchName, generateTicketBranch } from "./branch-naming.js";
const { start, interrupt, close } = vi.hoisted(() => ({
  start: vi.fn(),
  interrupt: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./codex-adapter.js", () => ({
  CodexAdapter: class {
    start = start;
    close = close;
  },
}));
const naming = {
  provider: "CODEX" as const,
  model: "model",
  effort: "low",
  prompt: "Name APP-1",
};
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
test("uses a temporary directory and text-only provider invocation", async () => {
  start.mockResolvedValue({
    completion: Promise.resolve({
      status: "COMPLETED",
      finalOutput: "feature/APP-1",
    }),
    interrupt,
  });
  expect(await generateBranchName(naming, new AbortController().signal)).toBe(
    "feature/APP-1",
  );
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      textOnly: true,
      run: expect.objectContaining({
        kind: "PLAN",
        webSearchEnabled: false,
        worktree: expect.objectContaining({
          folder: expect.stringContaining("aide-branch-"),
        }),
      }),
    }),
    expect.any(Object),
  );
  expect(close).toHaveBeenCalled();
});
test("generates collision suffixes with a single model request", async () => {
  start.mockResolvedValue({
    completion: Promise.resolve({
      status: "COMPLETED",
      finalOutput: "feature/APP-1",
    }),
    interrupt,
  });
  const result = await generateTicketBranch(
    {
      naming,
      takenBranches: ["feature/APP-1", "feature/APP-1-2"],
      currentBranch: null,
    },
    120_000,
    new AbortController().signal,
    async () => {},
  );
  expect(result).toMatchObject({ branchName: "feature/APP-1-3" });
  expect(start).toHaveBeenCalledTimes(1);
});
test("rejects provider failure and invalid output without retrying", async () => {
  start.mockResolvedValue({
    completion: Promise.resolve({
      status: "FAILED",
      error: "Provider unavailable",
    }),
    interrupt,
  });
  await expect(
    generateBranchName(naming, new AbortController().signal),
  ).rejects.toThrow("Provider unavailable");
  start.mockResolvedValue({
    completion: Promise.resolve({
      status: "COMPLETED",
      finalOutput: "Here is your branch",
    }),
    interrupt,
  });
  await expect(
    generateBranchName(naming, new AbortController().signal),
  ).rejects.toThrow("Invalid");
});
test("cancellation interrupts the provider and closes its resources", async () => {
  const controller = new AbortController();
  start.mockImplementation(async () => {
    queueMicrotask(() => controller.abort(new Error("Cancelled")));
    return { completion: new Promise(() => {}), interrupt };
  });
  await expect(generateBranchName(naming, controller.signal)).rejects.toThrow(
    "Cancelled",
  );
  expect(interrupt).toHaveBeenCalledWith("CANCELLED");
  expect(close).toHaveBeenCalled();
});

test("a generation failure occurs before the branch handler touches the repository", async () => {
  const { branchWorktree } = await import("../handlers/worktrees.js");
  start.mockResolvedValue({
    completion: Promise.resolve({
      status: "FAILED",
      error: "Provider unavailable",
    }),
    interrupt,
  });
  await expect(
    branchWorktree(
      {
        codebaseId: "codebase",
        rootFolder: "/nonexistent-aide-157-repository",
        folder: null,
        gitDirectory: null,
        expectedOrigin: "https://github.com/acme/repo",
        baseBranch: "main",
        action: "CREATE",
        mode: "NEW",
        candidates: [],
        stashOnFailure: false,
        aiNaming: { naming, takenBranches: [], currentBranch: null },
      },
      600_000,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow("Provider unavailable");
});

test("generation timeout interrupts a slow model", async () => {
  vi.useFakeTimers();
  start.mockResolvedValue({ completion: new Promise(() => {}), interrupt });
  const pending = generateBranchName(naming, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow(
    "timed out after 120 seconds",
  );
  await vi.waitFor(() => expect(start).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(120_001);
  await rejected;
  expect(interrupt).toHaveBeenCalledWith("CANCELLED");
});
