import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { OperationResource } from "@ai-development-environment/agent-contract/operation-resources";
import { RepositoryCoordinator } from "./repository-coordinator.js";

const worktree = (
  name: string,
  mode: OperationResource["mode"] = "WRITE",
): OperationResource => ({
  kind: "WORKTREE",
  key: name,
  mode,
  agentId: "agent",
  codebaseId: "repo",
});

describe("operation resources", () => {
  test("builds sibling worktrees concurrently while protecting only each source", async () => {
    const coordinator = new RepositoryCoordinator();
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const build = coordinator.withResources(
      [worktree("a", "BUILD")],
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;
    const mutateSame = vi.fn(async () => "updated");
    const waiting = coordinator.withResources([worktree("a")], mutateSame);
    await expect(
      coordinator.withResources(
        [worktree("b", "BUILD")],
        async () => "built b",
      ),
    ).resolves.toBe("built b");
    await expect(
      coordinator.withResources([worktree("c")], async () => "synced c"),
    ).resolves.toBe("synced c");
    await expect(
      coordinator.withResources([worktree("a", "READ")], async () => "detail"),
    ).resolves.toBe("detail");
    expect(mutateSame).not.toHaveBeenCalled();
    finish.resolve();
    await Promise.all([build, waiting]);
    expect(mutateSame).toHaveBeenCalledOnce();
  });

  test("keeps repository barriers fair without reserving unrelated repositories", async () => {
    const coordinator = new RepositoryCoordinator();
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const build = coordinator.withResources(
      [worktree("a", "BUILD")],
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;
    const events: string[] = [];
    const barrier = coordinator.withResources(
      [
        {
          kind: "CODEBASE",
          key: "repo",
          agentId: "agent",
          codebaseId: "repo",
          mode: "WRITE",
        },
      ],
      async () => {
        events.push("barrier");
      },
    );
    const sibling = coordinator.withResources(
      [worktree("b", "BUILD")],
      async () => {
        events.push("sibling");
      },
    );
    const session = coordinator.withResources(
      [worktree("agent:build-stability:b", "READ")],
      async () => {
        events.push("session");
      },
    );
    await expect(
      coordinator.withResources(
        [{ ...worktree("other"), codebaseId: "other" }],
        async () => "independent",
      ),
    ).resolves.toBe("independent");
    expect(events).toEqual([]);
    finish.resolve();
    await Promise.all([build, barrier, sibling, session]);
    expect(events).toEqual(["barrier", "sibling", "session"]);
  });

  test("acquires multiple worktrees atomically and cancels a waiting set", async () => {
    const coordinator = new RepositoryCoordinator();
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const build = coordinator.withResources(
      [worktree("a", "BUILD")],
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;
    const abort = new AbortController();
    const prepare = vi.fn(async () => {});
    const preparation = coordinator.withResources(
      [worktree("a"), worktree("b")],
      prepare,
      abort.signal,
    );
    const cancelled = expect(preparation).rejects.toMatchObject({
      name: "AbortError",
    });
    await Promise.resolve();
    abort.abort();
    await cancelled;
    await expect(
      coordinator.withResources([worktree("b")], async () => "free"),
    ).resolves.toBe("free");
    expect(prepare).not.toHaveBeenCalled();
    finish.resolve();
    await build;
  });

  test("retains an active cancelled build until cleanup finishes", async () => {
    const coordinator = new RepositoryCoordinator();
    const finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const abort = new AbortController();
    const build = coordinator.withResources(
      [worktree("a", "BUILD")],
      async () => {
        started.resolve();
        await finish.promise;
      },
      abort.signal,
    );
    await started.promise;
    abort.abort();
    const mutate = vi.fn(async () => {});
    const mutation = coordinator.withResources([worktree("a")], mutate);
    await expect(
      coordinator.tryWithResources([worktree("a")], async () => true),
    ).resolves.toEqual({ ran: false });
    expect(mutate).not.toHaveBeenCalled();
    finish.resolve();
    await Promise.all([build, mutation]);
    expect(mutate).toHaveBeenCalledOnce();
  });

  test("canonicalizes overlapping output paths and supports nested owner claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "operation-paths-"));
    try {
      await symlink(root, join(root, "alias"));
      await symlink(join(root, "cache"), join(root, "dangling"));
      const coordinator = new RepositoryCoordinator();
      const pathResource = (path: string): OperationResource => ({
        kind: "PATH",
        key: path,
        path,
        agentId: "agent",
        mode: "WRITE",
      });
      const finish = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const first = coordinator.withResources(
        [pathResource(join(root, "cache"))],
        async () => {
          await coordinator.withResources(
            [pathResource(join(root, "alias", "cache", "products"))],
            async () => {
              started.resolve();
              await finish.promise;
            },
          );
        },
      );
      await started.promise;
      const useOutput = vi.fn(async () => "second");
      const second = coordinator.withResources(
        [pathResource(join(root, "dangling", "products", "app"))],
        useOutput,
      );
      await expect(
        coordinator.withResources(
          [pathResource(join(root, "another-cache"))],
          async () => "independent",
        ),
      ).resolves.toBe("independent");
      expect(useOutput).not.toHaveBeenCalled();
      finish.resolve();
      await Promise.all([first, second]);
      expect(useOutput).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a nested expansion that forms a resource wait cycle", async () => {
    const coordinator = new RepositoryCoordinator();
    const bothStarted = Promise.withResolvers<void>();
    let starts = 0;
    const run = (own: string, other: string) =>
      coordinator.withResources([worktree(own)], async () => {
        if (++starts === 2) bothStarted.resolve();
        await bothStarted.promise;
        return coordinator.withResources([worktree(other)], async () => own);
      });
    const results = await Promise.allSettled([run("a", "b"), run("b", "a")]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { message: expect.stringContaining("would deadlock") },
    });
    await expect(
      coordinator.withResources(
        [worktree("a"), worktree("b")],
        async () => "released",
      ),
    ).resolves.toBe("released");
  });
});
