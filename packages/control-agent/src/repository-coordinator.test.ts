import { describe, expect, test, vi } from "vitest";

import { RepositoryCoordinator } from "./repository-coordinator.js";

describe("RepositoryCoordinator", () => {
  test("keeps inspections responsive during a build even behind queued mutations and reconciliation", async () => {
    const coordinator = new RepositoryCoordinator();
    const buildStarted = Promise.withResolvers<void>();
    const finishBuild = Promise.withResolvers<void>();
    const mutationStarted = Promise.withResolvers<void>();
    const finishMutation = Promise.withResolvers<void>();
    const events: string[] = [];
    const build = coordinator.runBuild("repo", async () => {
      buildStarted.resolve();
      await finishBuild.promise;
      events.push("build finished");
    });
    await buildStarted.promise;
    const mutation = coordinator.run("repo", async () => {
      events.push("mutation started");
      mutationStarted.resolve();
      await finishMutation.promise;
    });
    const reconcile = vi.fn(async () => {
      events.push("reconciliation");
    });
    const reconciliation = coordinator.runReconciliation("repo", reconcile);
    const inspection = coordinator.runInspection("repo", async () => {
      events.push("inspection");
      return "detail";
    });

    try {
      await expect(inspection).resolves.toBe("detail");
      expect(events).toEqual(["inspection"]);
      expect(reconcile).not.toHaveBeenCalled();

      finishBuild.resolve();
      await build;
      await mutationStarted.promise;
      const laterInspect = vi.fn(async () => "later detail");
      const laterInspection = coordinator.runInspection("repo", laterInspect);
      await Promise.resolve();
      expect(laterInspect).not.toHaveBeenCalled();

      finishMutation.resolve();
      await Promise.all([mutation, reconciliation, laterInspection]);
      expect(events).toEqual([
        "inspection",
        "build finished",
        "mutation started",
        "reconciliation",
      ]);
      expect(laterInspect).toHaveBeenCalledOnce();
    } finally {
      finishBuild.resolve();
      finishMutation.resolve();
      await Promise.allSettled([build, mutation, reconciliation]);
    }
  });

  test.each(["mutation", "reconciliation"] as const)(
    "waits for an active %s before starting a build",
    async (kind) => {
      const coordinator = new RepositoryCoordinator();
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const task = async () => {
        started.resolve();
        await finish.promise;
      };
      const blocker =
        kind === "mutation"
          ? coordinator.run("repo", task)
          : coordinator.runReconciliation("repo", task);
      await started.promise;
      const runBuild = vi.fn(async () => "built");
      const build = coordinator.runBuild("repo", runBuild);
      await Promise.resolve();
      expect(runBuild).not.toHaveBeenCalled();

      finish.resolve();
      await blocker;
      await expect(build).resolves.toBe("built");
    },
  );

  test("serializes builds while allowing inspections and independent repositories", async () => {
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const firstBuild = coordinator.runBuild("repo", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const second = vi.fn(async () => "second build");
    const secondBuild = coordinator.runBuild("repo", second);

    try {
      await expect(
        coordinator.runInspection("repo", async () => "detail"),
      ).resolves.toBe("detail");
      await expect(
        coordinator.run("another-repo", async () => "independent"),
      ).resolves.toBe("independent");
      expect(second).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await firstBuild;
    }
    await expect(secondBuild).resolves.toBe("second build");
  });

  test("keeps a cancelled build's lease until cleanup settles and active inspections finish", async () => {
    const coordinator = new RepositoryCoordinator();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const build = coordinator.runBuild(
      "repo",
      async () => {
        started.resolve();
        await finish.promise;
      },
      controller.signal,
    );
    await started.promise;
    const mutate = vi.fn(async () => "updated");
    const mutation = coordinator.run("repo", mutate);
    controller.abort();
    const inspectionStarted = Promise.withResolvers<void>();
    const finishInspection = Promise.withResolvers<void>();
    const inspection = coordinator.runInspection("repo", async () => {
      inspectionStarted.resolve();
      await finishInspection.promise;
    });

    try {
      await inspectionStarted.promise;
      expect(mutate).not.toHaveBeenCalled();
      finish.resolve();
      await build;
      expect(mutate).not.toHaveBeenCalled();
      finishInspection.resolve();
      await inspection;
      await expect(mutation).resolves.toBe("updated");
    } finally {
      finish.resolve();
      finishInspection.resolve();
      await Promise.allSettled([build, inspection, mutation]);
    }
  });

  test("removes a cancelled queued build without running it or retaining its lease", async () => {
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const mutation = coordinator.run("repo", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const controller = new AbortController();
    const runBuild = vi.fn(async () => {});
    const build = coordinator.runBuild("repo", runBuild, controller.signal);
    const cancelled = expect(build).rejects.toMatchObject({
      name: "AbortError",
    });
    const inspection = coordinator.runInspection("repo", async () => "detail");

    controller.abort();
    await cancelled;
    finish.resolve();
    await mutation;
    await expect(inspection).resolves.toBe("detail");
    expect(runBuild).not.toHaveBeenCalled();
    await expect(
      coordinator.runBuild("repo", async () => "next"),
    ).resolves.toBe("next");
  });

  test("releases a failed build so queued repository work can proceed", async () => {
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const build = coordinator.runBuild("repo", async () => {
      started.resolve();
      await finish.promise;
      throw new Error("build failed");
    });
    const rejected = expect(build).rejects.toThrow("build failed");
    await started.promise;
    const mutation = coordinator.run("repo", async () => "recovered");
    finish.resolve();
    await rejected;
    await expect(mutation).resolves.toBe("recovered");
  });

  test("removes a cancelled queued mutation so readers can proceed during a slow fetch", async () => {
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const reconciliation = coordinator.runReconciliation("repo", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const controller = new AbortController();
    const mutate = vi.fn(async () => {});
    const mutation = coordinator.run("repo", mutate, controller.signal);
    const cancelled = expect(mutation).rejects.toMatchObject({
      name: "AbortError",
    });
    const inspect = vi.fn(async () => "detail");
    const inspection = coordinator.runInspection("repo", inspect);
    await Promise.resolve();
    expect(inspect).not.toHaveBeenCalled();

    try {
      controller.abort();
      await cancelled;
      await expect(inspection).resolves.toBe("detail");
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await reconciliation;
    }
  });

  test("does not release an active mutation's lease until its handler settles after cancellation", async () => {
    const coordinator = new RepositoryCoordinator();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const mutation = coordinator.run(
      "repo",
      async () => {
        started.resolve();
        await finish.promise;
      },
      controller.signal,
    );
    await started.promise;
    const inspect = vi.fn(async () => "detail");
    const inspection = coordinator.runInspection("repo", inspect);
    controller.abort();
    await Promise.resolve();
    expect(inspect).not.toHaveBeenCalled();

    finish.resolve();
    await mutation;
    await expect(inspection).resolves.toBe("detail");
  });

  test("cancels a queued inspection without running it after a mutation finishes", async () => {
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const mutation = coordinator.run("repo", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const controller = new AbortController();
    const inspect = vi.fn(async () => {});
    const inspection = coordinator.runInspection(
      "repo",
      inspect,
      controller.signal,
    );
    const cancelled = expect(inspection).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await cancelled;
    finish.resolve();
    await mutation;
    expect(inspect).not.toHaveBeenCalled();
    await expect(coordinator.run("repo", async () => "ready")).resolves.toBe(
      "ready",
    );
  });

  test("loads inspections during reconciliation while preserving mutation order and fairness", async () => {
    const coordinator = new RepositoryCoordinator();
    const reconciliationStarted = Promise.withResolvers<void>();
    const finishReconciliation = Promise.withResolvers<void>();
    const inspectionStarted = Promise.withResolvers<void>();
    const finishInspection = Promise.withResolvers<void>();
    const mutationStarted = Promise.withResolvers<void>();
    const finishMutation = Promise.withResolvers<void>();
    const mutation = vi.fn(async () => {
      mutationStarted.resolve();
      await finishMutation.promise;
    });
    const lateInspection = vi.fn(async () => "later detail");

    const reconciliation = coordinator.runReconciliation("repo", async () => {
      reconciliationStarted.resolve();
      await finishReconciliation.promise;
    });
    await reconciliationStarted.promise;
    const inspection = coordinator.runInspection("repo", async () => {
      inspectionStarted.resolve();
      await finishInspection.promise;
      return "detail";
    });
    await inspectionStarted.promise;
    const write = coordinator.run("repo", mutation);
    const lateRead = coordinator.runInspection("repo", lateInspection);

    finishReconciliation.resolve();
    await reconciliation;
    expect(mutation).not.toHaveBeenCalled();
    expect(lateInspection).not.toHaveBeenCalled();

    finishInspection.resolve();
    await expect(inspection).resolves.toBe("detail");
    await mutationStarted.promise;
    expect(lateInspection).not.toHaveBeenCalled();

    finishMutation.resolve();
    await write;
    await expect(lateRead).resolves.toBe("later detail");
  });

  test("waits for active user mutations before inspecting or reconciling", async () => {
    const coordinator = new RepositoryCoordinator();
    const mutationStarted = Promise.withResolvers<void>();
    const finishMutation = Promise.withResolvers<void>();
    const inspect = vi.fn(async () => {});
    const reconcile = vi.fn(async () => {});
    const write = coordinator.run("repo", async () => {
      mutationStarted.resolve();
      await finishMutation.promise;
    });
    await mutationStarted.promise;
    const inspection = coordinator.runInspection("repo", inspect);
    const reconciliation = coordinator.runReconciliation("repo", reconcile);
    await Promise.resolve();
    expect(inspect).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();

    finishMutation.resolve();
    await Promise.all([write, inspection, reconciliation]);
    expect(inspect).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  test("waits for readers before updating the checkout without yielding report ownership to queued writers", async () => {
    const coordinator = new RepositoryCoordinator();
    const fetchStarted = Promise.withResolvers<void>();
    const finishFetch = Promise.withResolvers<void>();
    const readerStarted = Promise.withResolvers<void>();
    const finishReader = Promise.withResolvers<void>();
    const phaseRequested = Promise.withResolvers<void>();
    const phaseStarted = Promise.withResolvers<void>();
    const finishPhase = Promise.withResolvers<void>();
    const reportStarted = Promise.withResolvers<void>();
    const finishReport = Promise.withResolvers<void>();
    const updateCheckout = vi.fn(async () => {
      phaseStarted.resolve();
      await finishPhase.promise;
    });
    const userMutation = vi.fn(async () => {});
    const laterReader = vi.fn(async () => {});
    const reconciliation = coordinator.runReconciliation(
      "repo",
      async ({ runExclusive }) => {
        fetchStarted.resolve();
        await finishFetch.promise;
        phaseRequested.resolve();
        await runExclusive(updateCheckout);
        reportStarted.resolve();
        await finishReport.promise;
      },
    );
    await fetchStarted.promise;
    const reader = coordinator.runInspection("repo", async () => {
      readerStarted.resolve();
      await finishReader.promise;
    });
    await readerStarted.promise;
    const writer = coordinator.run("repo", userMutation);
    finishFetch.resolve();
    await phaseRequested.promise;
    const laterRead = coordinator.runInspection("repo", laterReader);
    expect(updateCheckout).not.toHaveBeenCalled();

    finishReader.resolve();
    await reader;
    await phaseStarted.promise;
    expect(userMutation).not.toHaveBeenCalled();
    expect(laterReader).not.toHaveBeenCalled();
    finishPhase.resolve();
    await reportStarted.promise;
    expect(userMutation).not.toHaveBeenCalled();

    finishReport.resolve();
    await Promise.all([reconciliation, writer, laterRead]);
    expect(userMutation).toHaveBeenCalledOnce();
    expect(laterReader).toHaveBeenCalledOnce();
  });

  test("releases an exclusive reconciliation phase after an exception", async () => {
    const coordinator = new RepositoryCoordinator();
    await expect(
      coordinator.runReconciliation("repo", async ({ runExclusive }) => {
        await expect(
          runExclusive(async () => {
            throw new Error("checkout update failed");
          }),
        ).rejects.toThrow("checkout update failed");
        return coordinator.runInspection("repo", async () => "still readable");
      }),
    ).resolves.toBe("still readable");
    await expect(coordinator.run("repo", async () => "writable")).resolves.toBe(
      "writable",
    );
  });

  test("releases failed operations and keeps different repositories independent", async () => {
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const failure = coordinator.runReconciliation("repo", async () => {
      started.resolve();
      await finish.promise;
      throw new Error("fetch failed");
    });
    const rejected = expect(failure).rejects.toThrow("fetch failed");
    await started.promise;
    await expect(
      coordinator.run("another-repo", async () => "independent"),
    ).resolves.toBe("independent");
    const next = coordinator.run("repo", async () => "recovered");
    finish.resolve();
    await rejected;
    await expect(next).resolves.toBe("recovered");
  });
});
