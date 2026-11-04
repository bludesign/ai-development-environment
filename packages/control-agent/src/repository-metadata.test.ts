import { describe, expect, test, vi } from "vitest";
import {
  withMetadataKey,
  withRepositoryMetadata,
} from "./repository-metadata.js";
import {
  git,
  repository,
  registerWorktreeFixtures,
  temporaryDirectories,
} from "./handlers/worktree-fixtures.js";

registerWorktreeFixtures();

describe("shared repository metadata", () => {
  test("recognizes linked worktrees as one metadata owner and allows nested access", async () => {
    const folder = await repository();
    const linked = `${folder}-linked`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "metadata", linked);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const first = withRepositoryMetadata(folder, async () => {
      await withRepositoryMetadata(linked, async () => {
        started.resolve();
        await finish.promise;
      });
    });
    await started.promise;
    const useSharedMetadata = vi.fn(async () => "updated");
    const second = withRepositoryMetadata(linked, useSharedMetadata);
    await withMetadataKey("independent", async () => undefined);
    expect(useSharedMetadata).not.toHaveBeenCalled();
    finish.resolve();
    await expect(second).resolves.toBe("updated");
    await first;
  });

  test("cancels a waiter promptly while keeping younger writers behind the owner", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const first = withMetadataKey("cancelled-waiter", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const abort = new AbortController();
    const cancelledTask = vi.fn(async () => {});
    const waiting = withMetadataKey(
      "cancelled-waiter",
      cancelledTask,
      abort.signal,
    );
    const cancelled = expect(waiting).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    await cancelled;
    const youngerTask = vi.fn(async () => "younger");
    const younger = withMetadataKey("cancelled-waiter", youngerTask);
    await Promise.resolve();
    expect(youngerTask).not.toHaveBeenCalled();
    expect(cancelledTask).not.toHaveBeenCalled();
    finish.resolve();
    await Promise.all([first, younger]);
  });
});
