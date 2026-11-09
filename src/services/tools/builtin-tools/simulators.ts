import * as z from "zod/v4";

import {
  SIMULATOR_ACTIONS,
  SIMULATOR_ACTION_JOB_KIND,
  SIMULATOR_CREATE_JOB_KIND,
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_RESET_JOB_KIND,
  type SimulatorJobKind,
} from "@ai-development-environment/agent-contract/simulators";

import {
  MAX_SIMULATOR_DELETE_TARGETS,
  type SimulatorAutomation,
  type SimulatorsService,
} from "@/services/simulators/simulators.service";

import {
  defineTool,
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  type BuiltInToolGroup,
  type ToolAnnotations,
} from "../builtin-tools";
import type { ToolInvocationContext } from "../tool-call-audit.service";

export const SIMULATORS_TOOL_GROUP_ID = "builtin:simulators";

const agentId = z.string().min(1);
const simulatorId = z.guid();
const target = z.strictObject({ agentId, simulatorId });
const requestId = z.string().trim().min(1).max(200);
const confirmation = z.literal(true);
const name = z.string().trim().min(1).max(200);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/);
const request = z.strictObject({ agentId, requestId });
const deviceRequest = request.extend({ simulatorId });

const jobSummary = z.object({
  jobId: z.string(),
  agentId,
  status: z.string(),
  timeoutSeconds: z.number(),
});
const device = z.object({
  id: simulatorId,
  name: z.string(),
  runtimeId: z.string(),
  runtimeName: z.string().nullable(),
  platform: z.string(),
  deviceTypeId: z.string().nullable(),
  state: z.string(),
  isAvailable: z.boolean(),
  availabilityError: z.string().nullable(),
  dataPath: z.string().nullable(),
});
const inventory = z.object({
  simulators: z.array(device),
  runtimes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      platform: z.string(),
      version: z.string(),
      deviceTypes: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});
const details = z.object({
  simulator: device,
  apps: z.array(
    z.object({
      bundleId: z.string(),
      name: z.string(),
      version: z.string().nullable(),
      build: z.string().nullable(),
      bundlePath: z.string().nullable(),
      dataPath: z.string().nullable(),
    }),
  ),
});

function assertRunAgent(
  context: ToolInvocationContext | undefined,
  agents: readonly string[],
): void {
  if (
    (context?.runId || context?.runAgentId) &&
    agents.some((agent) => agent !== context.runAgentId)
  ) {
    throw new Error(
      "Run-scoped MCP may only access simulators on the run agent",
    );
  }
}

function simulatorAutomation(
  context?: ToolInvocationContext,
): SimulatorAutomation {
  return {
    source:
      context?.source === "WORKFLOW" || context?.workflowRunId
        ? "WORKFLOW"
        : "MCP",
    requestScope: context?.runId
      ? ["run", context.runId]
      : context?.callerIdentity,
  };
}

export function createSimulatorToolGroup(
  service: SimulatorsService,
): BuiltInToolGroup {
  function queueTool<I extends z.ZodType<z.output<typeof request>>>(input: {
    name: string;
    title: string;
    description: string;
    inputSchema: I;
    annotations?: ToolAnnotations;
    kind: SimulatorJobKind;
    payload: (value: z.output<I>) => unknown;
  }) {
    return defineTool({
      name: input.name,
      title: input.title,
      description: `${input.description} Poll get_simulator_job for the result.`,
      inputSchema: input.inputSchema,
      outputSchema: jobSummary,
      annotations: input.annotations,
      handler: async (value, context) => {
        assertRunAgent(context, [value.agentId]);
        const job = await service.enqueue(
          value.agentId,
          value.requestId,
          input.kind,
          input.payload(value),
          simulatorAutomation(context),
        );
        return {
          jobId: job.id,
          agentId: job.agentId,
          status: job.status,
          timeoutSeconds: job.timeoutSeconds,
        };
      },
    });
  }

  return {
    id: SIMULATORS_TOOL_GROUP_ID,
    name: "Simulators",
    children: [],
    tools: [
      queueTool({
        name: "refresh_simulator_inventory",
        title: "Refresh simulator inventory",
        description:
          "List simulators, installed runtimes, and available device types on an agent.",
        inputSchema: request,
        kind: SIMULATOR_INVENTORY_JOB_KIND,
        payload: () => ({}),
      }),
      queueTool({
        name: "inspect_simulator",
        title: "Inspect simulator",
        description:
          "Read simulator details and installed apps from its owning agent.",
        inputSchema: deviceRequest,
        kind: SIMULATOR_INSPECT_JOB_KIND,
        payload: ({ simulatorId }) => ({ simulatorId }),
      }),
      defineTool({
        name: "get_simulator_job",
        title: "Get simulator job",
        description:
          "Read one simulator job and its typed result from the specified agent.",
        inputSchema: z.strictObject({ agentId, jobId: z.string().min(1) }),
        outputSchema: z.object({
          job: jobSummary.extend({
            operation: z.enum([
              "INVENTORY",
              "INSPECT",
              "CREATE",
              "RESET",
              ...SIMULATOR_ACTIONS,
            ]),
            error: z.string().nullable(),
            simulatorId: simulatorId.nullable(),
            bundleId: z.string().nullable(),
            inventory: inventory.nullable(),
            details: details.nullable(),
          }),
        }),
        handler: async ({ agentId, jobId }, context) => {
          assertRunAgent(context, [agentId]);
          return { job: await service.getJob(agentId, jobId) };
        },
      }),
      queueTool({
        name: "create_simulator",
        title: "Create simulator",
        description:
          "Create a simulator using an installed runtime and a supported device type.",
        inputSchema: request.extend({
          name,
          runtimeId: identifier,
          deviceTypeId: identifier,
        }),
        annotations: WRITE_ANNOTATIONS,
        kind: SIMULATOR_CREATE_JOB_KIND,
        payload: ({ name, runtimeId, deviceTypeId }) => ({
          name,
          runtimeId,
          deviceTypeId,
        }),
      }),
      ...(
        [
          [
            "BOOT",
            "boot_simulator",
            "Boot simulator",
            "Start a simulator. The job finishes when the simulator is ready.",
          ],
          [
            "SHUTDOWN",
            "shutdown_simulator",
            "Shut down simulator",
            "Shut down a simulator.",
          ],
          [
            "REBOOT",
            "reboot_simulator",
            "Reboot simulator",
            "Restart a booted simulator.",
          ],
        ] as const
      ).map(([action, name, title, description]) =>
        queueTool({
          name,
          title,
          description,
          inputSchema: deviceRequest,
          annotations: DESTRUCTIVE_ANNOTATIONS,
          kind: SIMULATOR_ACTION_JOB_KIND,
          payload: ({ simulatorId }) => ({ action, simulatorId }),
        }),
      ),
      ...(
        [
          [
            "RENAME",
            "rename_simulator",
            "Rename simulator",
            "Rename a simulator.",
          ],
          [
            "CLONE",
            "clone_simulator",
            "Clone simulator",
            "Clone a shut-down simulator.",
          ],
        ] as const
      ).map(([action, toolName, title, description]) =>
        queueTool({
          name: toolName,
          title,
          description,
          inputSchema: deviceRequest.extend({ name }),
          annotations: WRITE_ANNOTATIONS,
          kind: SIMULATOR_ACTION_JOB_KIND,
          payload: ({ simulatorId, name }) => ({ action, simulatorId, name }),
        }),
      ),
      queueTool({
        name: "erase_simulator",
        title: "Erase simulator",
        description: "Erase all content and settings on a shut-down simulator.",
        inputSchema: deviceRequest.extend({ confirm: confirmation }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        kind: SIMULATOR_ACTION_JOB_KIND,
        payload: ({ simulatorId }) => ({ action: "ERASE", simulatorId }),
      }),
      defineTool({
        name: "delete_simulators",
        title: "Delete selected simulators",
        description:
          "Delete explicitly selected simulators, including eligible simulators with missing runtimes. Poll each returned job with get_simulator_job.",
        inputSchema: z.strictObject({
          requestId,
          confirm: confirmation,
          targets: z.array(target).min(1).max(MAX_SIMULATOR_DELETE_TARGETS),
        }),
        outputSchema: z.object({
          targets: z.array(
            target.extend({
              jobId: z.string().nullable(),
              status: z.string().nullable(),
              error: z.string().nullable(),
            }),
          ),
        }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: ({ targets, requestId }, context) => {
          assertRunAgent(
            context,
            targets.map(({ agentId }) => agentId),
          );
          return service.deleteSelected(
            targets,
            requestId,
            simulatorAutomation(context),
          );
        },
      }),
      queueTool({
        name: "reset_simulators",
        title: "Reset to default simulators",
        description:
          "Replace the roster of one agent with Xcode defaults. All simulators on that agent must be shut down.",
        inputSchema: request.extend({ confirm: confirmation }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        kind: SIMULATOR_RESET_JOB_KIND,
        payload: () => ({}),
      }),
      queueTool({
        name: "open_simulator_data_folder",
        title: "Open simulator data folder",
        description:
          "Open the simulator data folder in Finder on its owning agent.",
        inputSchema: deviceRequest,
        annotations: WRITE_ANNOTATIONS,
        kind: SIMULATOR_ACTION_JOB_KIND,
        payload: ({ simulatorId }) => ({
          action: "OPEN_DATA_FOLDER",
          simulatorId,
        }),
      }),
      ...(
        [
          [
            "LAUNCH_APP",
            "launch_simulator_app",
            "Launch simulator app",
            "Launch an installed app on a booted simulator.",
            DESTRUCTIVE_ANNOTATIONS,
          ],
          [
            "TERMINATE_APP",
            "terminate_simulator_app",
            "Terminate simulator app",
            "Terminate an app on a booted simulator.",
            DESTRUCTIVE_ANNOTATIONS,
          ],
          [
            "OPEN_APP_BUNDLE_FOLDER",
            "reveal_simulator_app_bundle",
            "Reveal simulator app bundle",
            "Reveal an installed app bundle in Finder on its owning agent.",
            WRITE_ANNOTATIONS,
          ],
          [
            "OPEN_APP_DATA_FOLDER",
            "open_simulator_app_data_folder",
            "Open simulator app data folder",
            "Open an installed app data folder in Finder on its owning agent.",
            WRITE_ANNOTATIONS,
          ],
        ] as const
      ).map(([action, name, title, description, annotations]) =>
        queueTool({
          name,
          title,
          description,
          annotations,
          inputSchema: deviceRequest.extend({ bundleId: identifier }),
          kind: SIMULATOR_ACTION_JOB_KIND,
          payload: ({ simulatorId, bundleId }) => ({
            action,
            simulatorId,
            bundleId,
          }),
        }),
      ),
    ],
  };
}
