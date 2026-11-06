import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

export type ObservedBuildDeployment = {
  id: string;
  status: string;
  destination?: { name: string };
  error?: string | null;
  transfer?: { status: string; error: string | null } | null;
};

const FIELDS =
  "deployments { id status destination error transfer { status error } }";
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const TRANSFER_FAILED = new Set(["FAILED", "CANCELLED", "EXPIRED"]);
const failedTransfer = (deployment: ObservedBuildDeployment) =>
  !!(deployment.transfer && TRANSFER_FAILED.has(deployment.transfer.status));

/** Observe only the accepted run, so older failures on this build cannot leak into it. */
export async function observeBuildDeployments({
  buildId,
  deployments,
  signal,
  onError,
  fallbackError,
}: {
  buildId: string;
  deployments: ObservedBuildDeployment[];
  signal: AbortSignal;
  onError: (message: string | null) => void;
  fallbackError: string;
}): Promise<string | null> {
  signal.throwIfAborted();
  const tracked = new Map(
    deployments.map((deployment) => [deployment.id, deployment]),
  );
  const done = Promise.withResolvers<void>();
  let finished = false;
  let failure: string | null = null;
  const apply = (updates: ObservedBuildDeployment[]) => {
    if (signal.aborted || finished) return;
    for (const update of updates) {
      const previous = tracked.get(update.id);
      if (!previous) continue;
      // A read started before a live event may finish afterward. Terminal
      // deployments/transfers cannot become queued again in that stale read.
      if (TERMINAL.has(previous.status) && update.status !== previous.status)
        continue;
      if (
        failedTransfer(previous) &&
        !TERMINAL.has(update.status) &&
        !failedTransfer(update)
      )
        continue;
      tracked.set(update.id, { ...previous, ...update });
    }
    const values = [...tracked.values()];
    const failed = (deployment: ObservedBuildDeployment) =>
      deployment.status !== "SUCCEEDED" &&
      (TERMINAL.has(deployment.status) ||
        !!(
          deployment.transfer && TRANSFER_FAILED.has(deployment.transfer.status)
        ));
    const failures = values
      .filter(failed)
      .map(
        (deployment) =>
          `${deployment.destination?.name ?? deployment.id}: ${deployment.error || deployment.transfer?.error || fallbackError}`,
      );
    failure = failures.length ? failures.join("\n") : null;
    onError(failure);
    if (
      values.every(
        (deployment) => TERMINAL.has(deployment.status) || failed(deployment),
      )
    ) {
      finished = true;
      done.resolve();
    }
  };
  apply(deployments);
  if (finished) return failure;
  signal.throwIfAborted();
  const owner = createRefreshCoalescer(async (readSignal) => {
    try {
      const data = await controlPlaneRequest<{
        build: { deployments: ObservedBuildDeployment[] } | null;
      }>(
        `query BuildRunProgress($id: ID!) { build(id: $id) { ${FIELDS} } }`,
        { id: buildId },
        { signal: readSignal },
      );
      if (readSignal.aborted || signal.aborted || finished) return;
      if (!data.build) {
        failure = fallbackError;
        onError(failure);
        finished = true;
        done.resolve();
      } else apply(data.build.deployments);
    } catch (error) {
      if (!readSignal.aborted && !signal.aborted && !finished)
        onError(error instanceof Error ? error.message : String(error));
    }
  });
  const abort = () => done.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    unsubscribe = controlPlaneSubscriptions().subscribe<{
      buildSnapshotChanged: { deployments: ObservedBuildDeployment[] } | null;
    }>(
      {
        query: `subscription BuildRunProgressChanged($id: ID!) { buildSnapshotChanged(id: $id) { ${FIELDS} } }`,
        variables: { id: buildId },
      },
      {
        next: (event) => {
          const build = event.data?.buildSnapshotChanged;
          if (build) apply(build.deployments);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    if (!finished) {
      timer = setInterval(() => void owner.refreshIfIdle(), 2_000);
      void owner.refresh();
    }
    await done.promise;
    return failure;
  } finally {
    signal.removeEventListener("abort", abort);
    if (timer) clearInterval(timer);
    unsubscribe();
    owner.dispose();
  }
}
