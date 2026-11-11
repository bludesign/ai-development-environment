import "server-only";

import { createHash } from "node:crypto";

import {
  SIMULATOR_ACTION_JOB_KIND,
  SIMULATOR_CREATE_JOB_KIND,
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_RESET_JOB_KIND,
  simulatorActionPayload,
  simulatorCreatePayload,
  simulatorInspectPayload,
  type SimulatorJobKind,
} from "@ai-development-environment/agent-contract/simulators";

import {
  SIMULATOR_APP_ACTIONS,
  SIMULATOR_DEVICE_ACTIONS,
  SIMULATOR_FOLDER_ACTIONS,
} from "@/lib/workflows/simulators";
import { waitResumeAfter, waitTimeoutAt } from "@/lib/workflows/wait-timing";
import type { SimulatorsService } from "@/services/simulators/simulators.service";

import type {
  WorkflowExecutionContext,
  WorkflowExecutionResult,
  WorkflowStepExecutor,
} from "./step-executor";
import type {
  WorkflowsService,
  WorkflowWaitPollResult,
} from "./workflows.service";

export const SIMULATOR_JOBS_WAIT = "SIMULATOR_JOBS";
export const WORKFLOW_RUN_CANCELLED = Symbol("Workflow run cancelled");

const BULK_DELETE_WAIT_SECONDS = 3_600;

type DeleteInput = Parameters<SimulatorsService["deleteSelected"]>[0];
type Target = Awaited<
  ReturnType<SimulatorsService["deleteSelected"]>
>["targets"][number];
type WaitTarget = Omit<Target, "simulatorId"> & { simulatorId: string | null };
type WaitData = { bulk: boolean; targets: WaitTarget[]; operation?: string };

const source = { source: "WORKFLOW" } as const;

function requestId({ run, node, attempt }: WorkflowExecutionContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        run.id,
        node.id,
        attempt.generation,
        attempt.iterationKey,
      ]),
    )
    .digest("hex");
}

function confirm(value: unknown): void {
  if (value !== true)
    throw new Error("Simulator operation requires confirmation");
}

function waitFor(
  context: WorkflowExecutionContext,
  data: WaitData,
  defaultTimeoutSeconds: number | null,
): WorkflowExecutionResult {
  return {
    links: data.targets.flatMap(({ agentId, simulatorId, jobId }) =>
      jobId
        ? [
            {
              kind: "AGENT_JOB",
              resourceId: jobId,
              label: "Simulator job",
              url: `/dashboard/jobs/${jobId}`,
              metadata: { agentId, simulatorId },
            },
          ]
        : [],
    ),
    wait: {
      kind: SIMULATOR_JOBS_WAIT,
      externalKey: JSON.stringify(data),
      resumeAfter: waitResumeAfter(context.node.config),
      timeoutAt: waitTimeoutAt(context.node.config, defaultTimeoutSeconds),
    },
  };
}

async function pollSimulatorJobs(
  service: SimulatorsService,
  data: WaitData,
  timedOut: boolean,
): Promise<WorkflowWaitPollResult> {
  const jobs = await service.getJobs(
    data.targets.flatMap(({ agentId, jobId }) =>
      jobId ? [{ agentId, jobId }] : [],
    ),
  );
  const byId = new Map(jobs.map((job) => [job.jobId, job]));
  const results = data.targets.map((target) => {
    if (!target.jobId) return { ...target, status: "FAILED" };
    const job = byId.get(target.jobId);
    if (!job || job.agentId !== target.agentId) {
      return { ...target, status: "FAILED", error: "Simulator job not found" };
    }
    return data.bulk
      ? { ...target, status: job.status, error: job.error }
      : job;
  });
  const pending = results.some(({ status }) =>
    ["QUEUED", "RUNNING", "CANCELLING"].includes(status),
  );
  if (pending && !timedOut) return { pending: true, pollAfterSeconds: 2 };

  const failures = results.filter(
    ({ status, error }) => status !== "SUCCEEDED" || error,
  );
  const result = data.bulk
    ? { targets: results }
    : { operation: data.operation, ...results[0] };
  return {
    pending: false,
    result,
    error: pending
      ? "Workflow wait for simulator jobs timed out"
      : !failures.length
        ? null
        : data.bulk
          ? `${failures.length} of ${results.length} simulator deletions failed`
          : (failures[0]!.error ??
            `Simulator job ${failures[0]!.status.toLowerCase()}`),
  };
}

export function registerSimulatorAdapters(
  workflows: WorkflowsService,
  executor: WorkflowStepExecutor,
  service: SimulatorsService,
): void {
  workflows.registerWaitPoller(SIMULATOR_JOBS_WAIT, (externalKey, timedOut) =>
    pollSimulatorJobs(service, JSON.parse(externalKey) as WaitData, timedOut),
  );

  async function submit(
    context: WorkflowExecutionContext,
    kind: SimulatorJobKind,
    operation: string,
    payload: object,
  ) {
    const agentId = context.node.config.agentId;
    if (typeof agentId !== "string" || !agentId.trim())
      throw new Error("Simulator agent is required");
    const simulatorId =
      "simulatorId" in payload && typeof payload.simulatorId === "string"
        ? payload.simulatorId
        : null;
    let target: WaitTarget;
    let defaultTimeoutSeconds: number | null = null;
    try {
      const job = await service.enqueue(
        agentId.trim(),
        requestId(context),
        kind,
        payload,
        source,
      );
      target = {
        agentId: job.agentId,
        simulatorId,
        jobId: job.id,
        status: job.status,
        error: job.error,
      };
      defaultTimeoutSeconds = job.timeoutSeconds;
    } catch (error) {
      target = {
        agentId: agentId.trim(),
        simulatorId,
        jobId: null,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return waitFor(
      context,
      { bulk: false, targets: [target], operation },
      defaultTimeoutSeconds,
    );
  }

  function action(
    context: WorkflowExecutionContext,
    choices: readonly string[],
  ) {
    const {
      action,
      simulatorId,
      name,
      bundleId,
      confirm: confirmed,
    } = context.node.config;
    if (typeof action !== "string" || !choices.includes(action))
      throw new Error("Unsupported action for this simulator step");
    if (action === "ERASE") confirm(confirmed);
    const payload = simulatorActionPayload({
      action,
      simulatorId,
      ...(action === "RENAME" || action === "CLONE" ? { name } : {}),
      ...(action === "LAUNCH_APP" ||
      action === "TERMINATE_APP" ||
      action === "OPEN_APP_BUNDLE_FOLDER" ||
      action === "OPEN_APP_DATA_FOLDER"
        ? { bundleId }
        : {}),
    });
    return submit(context, SIMULATOR_ACTION_JOB_KIND, action, payload);
  }

  executor.register("SIMULATOR_INVENTORY", (context) =>
    submit(context, SIMULATOR_INVENTORY_JOB_KIND, "INVENTORY", {
      platform: context.node.config.platform,
    }),
  );
  executor.register("SIMULATOR_INSPECT", (context) =>
    submit(
      context,
      SIMULATOR_INSPECT_JOB_KIND,
      "INSPECT",
      simulatorInspectPayload({ simulatorId: context.node.config.simulatorId }),
    ),
  );
  executor.register("SIMULATOR_CREATE", (context) => {
    const { name, runtimeId, deviceTypeId, platform } = context.node.config;
    return submit(
      context,
      SIMULATOR_CREATE_JOB_KIND,
      "CREATE",
      simulatorCreatePayload({ name, runtimeId, deviceTypeId, platform }),
    );
  });
  executor.register("SIMULATOR_DEVICE_ACTION", (context) =>
    action(context, SIMULATOR_DEVICE_ACTIONS),
  );
  executor.register("SIMULATOR_APP_ACTION", (context) =>
    action(context, SIMULATOR_APP_ACTIONS),
  );
  executor.register("SIMULATOR_OPEN_FOLDER", (context) =>
    action(context, SIMULATOR_FOLDER_ACTIONS),
  );
  executor.register("SIMULATOR_DELETE", async (context) => {
    confirm(context.node.config.confirm);
    const targets = context.node.config.targets;
    if (!Array.isArray(targets))
      throw new Error("Simulator deletion requires target pairs");
    const submitted = await service.deleteSelected(
      targets as DeleteInput,
      requestId(context),
      source,
      () => context.signal.reason === WORKFLOW_RUN_CANCELLED,
    );
    return waitFor(
      context,
      { bulk: true, targets: submitted.targets },
      BULK_DELETE_WAIT_SECONDS,
    );
  });
  executor.register("SIMULATOR_RESET", (context) => {
    confirm(context.node.config.confirm);
    return submit(context, SIMULATOR_RESET_JOB_KIND, "RESET", {});
  });
}
