import type { ActiveAgentOption } from "@/components/active-agent/active-agent-provider";
import type { AgentJob } from "@/components/agents/types";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

export type SimulatorPlatform = "APPLE" | "ANDROID";

export function simulatorPlatform(
  simulatorId: string,
): SimulatorPlatform | undefined {
  return simulatorId.startsWith("android:") ? "ANDROID" : undefined;
}

export type Simulator = {
  id: string;
  name: string;
  runtimeId: string;
  runtimeName: string | null;
  platform: string;
  deviceTypeId: string | null;
  state: string;
  isAvailable: boolean;
  availabilityError: string | null;
  dataPath: string | null;
};

export type SimulatorRuntime = {
  id: string;
  name: string;
  platform: string;
  version: string;
  deviceTypes: Array<{ id: string; name: string }>;
};

export type SimulatorInventory = {
  simulators: Simulator[];
  runtimes: SimulatorRuntime[];
};

export type SimulatorApp = {
  bundleId: string;
  name: string;
  version: string | null;
  build: string | null;
  bundlePath: string | null;
  dataPath: string | null;
};

export type SimulatorDetails = {
  simulator: Simulator;
  apps: SimulatorApp[];
};

export type SimulatorAction =
  | "BOOT"
  | "SHUTDOWN"
  | "REBOOT"
  | "RENAME"
  | "CLONE"
  | "ERASE"
  | "DELETE"
  | "LAUNCH_APP"
  | "TERMINATE_APP"
  | "OPEN_DATA_FOLDER"
  | "OPEN_APP_BUNDLE_FOLDER"
  | "OPEN_APP_DATA_FOLDER";

export type SimulatorActionInput = {
  agentId: string;
  simulatorId: string;
  action: SimulatorAction;
  name?: string;
  bundleId?: string;
  platform?: SimulatorPlatform;
};

export type CreateSimulatorInput = {
  agentId: string;
  name: string;
  runtimeId: string;
  deviceTypeId: string;
  platform?: SimulatorPlatform;
};

type SimulatorJob = Pick<AgentJob, "id" | "agentId" | "status" | "error"> & {
  simulatorInventory?: SimulatorInventory | null;
  simulatorDetails?: SimulatorDetails | null;
};

const SIMULATOR_FIELDS = `
  id name runtimeId runtimeName platform deviceTypeId state isAvailable availabilityError dataPath
`;
const JOB_FIELDS = "id agentId status error";
const INVENTORY_FIELDS = `${JOB_FIELDS}
  simulatorInventory {
    simulators { ${SIMULATOR_FIELDS} }
    runtimes { id name platform version deviceTypes { id name } }
  }
`;
const DETAIL_FIELDS = `${JOB_FIELDS}
  simulatorDetails {
    simulator { ${SIMULATOR_FIELDS} }
    apps { bundleId name version build bundlePath dataPath }
  }
`;

const TERMINAL = new Set<SimulatorJob["status"]>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

function waitForJob(
  initial: SimulatorJob,
  operation: string,
  fields: string,
  signal: AbortSignal,
): Promise<SimulatorJob> {
  signal.throwIfAborted();
  if (TERMINAL.has(initial.status)) return Promise.resolve(initial);

  return new Promise((resolve, reject) => {
    let disposed = false;
    let polling = false;
    let unsubscribe = () => {};
    const cleanup = () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const apply = (job: SimulatorJob | null | undefined) => {
      if (disposed || !job || !TERMINAL.has(job.status)) return;
      cleanup();
      resolve(job);
    };
    const poll = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        const data = await controlPlaneRequest<{
          agentJob: SimulatorJob | null;
        }>(
          `query ${operation}($id: ID!) { agentJob(id: $id) { ${fields} } }`,
          { id: initial.id },
          { signal },
        );
        apply(data.agentJob);
      } catch {
        // Reconcile again after transient request failures.
      } finally {
        polling = false;
      }
    };
    const interval = window.setInterval(() => void poll(), 2_000);
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "The simulator job is still running. Check the agent job history.",
        ),
      );
    }, 10 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    unsubscribe = controlPlaneSubscriptions().subscribe<{
      agentJobChanged: SimulatorJob;
    }>(
      {
        query: `subscription ${operation}Changed($id: ID!) { agentJobChanged(jobId: $id) { ${fields} } }`,
        variables: { id: initial.id },
      },
      {
        next: (value) => apply(value.data?.agentJobChanged),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    if (disposed) unsubscribe();
    else void poll();
  });
}

async function runJob(
  mutation: string,
  variables: Record<string, unknown>,
  operation: string,
  fields: string,
  signal: AbortSignal,
  options?: { cancelBeforeDispatch: true },
) {
  const result = await controlPlaneRequest<Record<string, SimulatorJob>>(
    mutation,
    variables,
    { signal, ...options },
  );
  const initial = Object.values(result)[0];
  if (!initial) throw new Error("The simulator job did not start.");
  const job = await waitForJob(initial, operation, fields, signal);
  if (job.status !== "SUCCEEDED") {
    throw new Error(job.error || `Simulator job ${job.status.toLowerCase()}`);
  }
  return job;
}

export async function refreshSimulatorInventory(
  agentId: string,
  signal: AbortSignal,
  platform?: SimulatorPlatform,
) {
  const job = await runJob(
    `mutation RefreshSimulatorInventory($agentId: ID!, $requestId: ID!, $platform: SimulatorPlatform) {
      refreshSimulatorInventory(agentId: $agentId, requestId: $requestId, platform: $platform) { ${INVENTORY_FIELDS} }
    }`,
    { agentId, requestId: createClientId(), ...(platform ? { platform } : {}) },
    "SimulatorInventoryJob",
    INVENTORY_FIELDS,
    signal,
    { cancelBeforeDispatch: true },
  );
  if (!job.simulatorInventory)
    throw new Error(
      "The simulator inventory was missing from the job response.",
    );
  return job.simulatorInventory;
}

export async function inspectSimulator(
  agentId: string,
  simulatorId: string,
  signal: AbortSignal,
) {
  const job = await runJob(
    `mutation InspectSimulator($agentId: ID!, $simulatorId: ID!, $requestId: ID!, $platform: SimulatorPlatform) {
      inspectSimulator(agentId: $agentId, simulatorId: $simulatorId, requestId: $requestId, platform: $platform) { ${DETAIL_FIELDS} }
    }`,
    {
      agentId,
      simulatorId,
      requestId: createClientId(),
      ...(simulatorPlatform(simulatorId)
        ? { platform: simulatorPlatform(simulatorId) }
        : {}),
    },
    "SimulatorDetailJob",
    DETAIL_FIELDS,
    signal,
    { cancelBeforeDispatch: true },
  );
  if (!job.simulatorDetails)
    throw new Error(
      "The simulator details were missing from the job response.",
    );
  return job.simulatorDetails;
}

export function createSimulator(
  input: CreateSimulatorInput,
  signal: AbortSignal,
) {
  return runJob(
    `mutation CreateSimulator($input: CreateSimulatorInput!) { createSimulator(input: $input) { ${JOB_FIELDS} } }`,
    { input: { ...input, requestId: createClientId() } },
    "SimulatorActionJob",
    JOB_FIELDS,
    signal,
  );
}

export function resetSimulators(agentId: string, signal: AbortSignal) {
  return runJob(
    `mutation ResetSimulators($agentId: ID!, $requestId: ID!) {
      resetSimulators(agentId: $agentId, requestId: $requestId) { ${JOB_FIELDS} }
    }`,
    { agentId, requestId: createClientId() },
    "SimulatorActionJob",
    JOB_FIELDS,
    signal,
  );
}

export function performSimulatorAction(
  input: SimulatorActionInput,
  signal: AbortSignal,
) {
  const platform = input.platform ?? simulatorPlatform(input.simulatorId);
  return runJob(
    `mutation SimulatorAction($input: SimulatorActionInput!) {
      performSimulatorAction(input: $input) { ${JOB_FIELDS} }
    }`,
    {
      input: {
        ...input,
        ...(platform ? { platform } : {}),
        requestId: createClientId(),
      },
    },
    "SimulatorActionJob",
    JOB_FIELDS,
    signal,
  );
}

export function simulatorAgentSupports(
  agent: ActiveAgentOption,
  capability: string,
  platform: SimulatorPlatform = "APPLE",
) {
  return (
    agent.connectionStatus === "ONLINE" &&
    (platform === "ANDROID"
      ? capability !== "reset" &&
        Boolean(agent.capabilities?.includes("android.simulators"))
      : Boolean(agent.capabilities?.includes(`simulators.${capability}`)))
  );
}

export function simulatorHref(agentId: string, simulatorId: string) {
  return `/system/simulators/${encodeURIComponent(agentId)}/${encodeURIComponent(simulatorId)}`;
}
