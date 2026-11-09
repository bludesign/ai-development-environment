import { describe, expect, test, vi } from "vitest";

import type { SimulatorsService } from "@/services/simulators/simulators.service";

import { createBuiltInToolRegistry } from "../builtin-tools";

const agentId = "studio";
const simulatorId = "CB8F6525-07C9-439E-B52D-2F7FC98BBF90";
const request = { agentId, requestId: "request-1" };
const device = { ...request, simulatorId };

function registry() {
  const enqueue = vi.fn().mockResolvedValue({
    id: "job-1",
    agentId,
    status: "QUEUED",
    timeoutSeconds: 120,
  });
  const getJob = vi.fn().mockResolvedValue({
    jobId: "job-1",
    agentId,
    status: "SUCCEEDED",
    timeoutSeconds: 120,
    operation: "INVENTORY",
    error: null,
    simulatorId: null,
    bundleId: null,
    inventory: { simulators: [], runtimes: [] },
    details: null,
  });
  const deleteSelected = vi.fn().mockResolvedValue({
    targets: [
      { agentId, simulatorId, jobId: "job-1", status: "QUEUED", error: null },
      {
        agentId: "remote",
        simulatorId,
        jobId: null,
        status: null,
        error: "Agent is offline",
      },
    ],
  });
  const tools = createBuiltInToolRegistry({
    codebaseTools: {} as never,
    simulators: {
      enqueue,
      getJob,
      deleteSelected,
    } as unknown as SimulatorsService,
  });
  return { tools, enqueue, getJob, deleteSelected };
}

describe("simulator tools", () => {
  test.each([
    ["refresh_simulator_inventory", request, "simulators.inventory", {}],
    ["inspect_simulator", device, "simulators.inspect", { simulatorId }],
    [
      "create_simulator",
      { ...request, name: "Phone", runtimeId: "runtime", deviceTypeId: "type" },
      "simulators.create",
      { name: "Phone", runtimeId: "runtime", deviceTypeId: "type" },
    ],
    [
      "boot_simulator",
      device,
      "simulators.action",
      { simulatorId, action: "BOOT" },
    ],
    [
      "shutdown_simulator",
      device,
      "simulators.action",
      { simulatorId, action: "SHUTDOWN" },
    ],
    [
      "reboot_simulator",
      device,
      "simulators.action",
      { simulatorId, action: "REBOOT" },
    ],
    [
      "rename_simulator",
      { ...device, name: "New name" },
      "simulators.action",
      { simulatorId, action: "RENAME", name: "New name" },
    ],
    [
      "clone_simulator",
      { ...device, name: "Clone" },
      "simulators.action",
      { simulatorId, action: "CLONE", name: "Clone" },
    ],
    [
      "erase_simulator",
      { ...device, confirm: true },
      "simulators.action",
      { simulatorId, action: "ERASE" },
    ],
    ["reset_simulators", { ...request, confirm: true }, "simulators.reset", {}],
    [
      "open_simulator_data_folder",
      device,
      "simulators.action",
      { simulatorId, action: "OPEN_DATA_FOLDER" },
    ],
    [
      "launch_simulator_app",
      { ...device, bundleId: "com.example.app" },
      "simulators.action",
      { simulatorId, bundleId: "com.example.app", action: "LAUNCH_APP" },
    ],
    [
      "terminate_simulator_app",
      { ...device, bundleId: "com.example.app" },
      "simulators.action",
      { simulatorId, bundleId: "com.example.app", action: "TERMINATE_APP" },
    ],
    [
      "reveal_simulator_app_bundle",
      { ...device, bundleId: "com.example.app" },
      "simulators.action",
      {
        simulatorId,
        bundleId: "com.example.app",
        action: "OPEN_APP_BUNDLE_FOLDER",
      },
    ],
    [
      "open_simulator_app_data_folder",
      { ...device, bundleId: "com.example.app" },
      "simulators.action",
      {
        simulatorId,
        bundleId: "com.example.app",
        action: "OPEN_APP_DATA_FOLDER",
      },
    ],
  ])(
    "queues %s and returns the job ID immediately",
    async (name, input, kind, payload) => {
      const { tools, enqueue } = registry();
      await expect(tools.callByName(name, input)).resolves.toMatchObject({
        structuredContent: {
          jobId: "job-1",
          agentId,
          status: "QUEUED",
          timeoutSeconds: 120,
        },
      });
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        agentId,
        request.requestId,
        kind,
        payload,
        { source: "MCP" },
      );
    },
  );

  test("projects job results and preserves per-target deletion outcomes", async () => {
    const { tools, getJob, deleteSelected } = registry();
    await expect(
      tools.callByName("get_simulator_job", { agentId, jobId: "job-1" }),
    ).resolves.toMatchObject({
      structuredContent: {
        job: { jobId: "job-1", inventory: { simulators: [], runtimes: [] } },
      },
    });
    expect(getJob).toHaveBeenCalledExactlyOnceWith(agentId, "job-1");
    const targets = [
      { agentId, simulatorId },
      { agentId: "remote", simulatorId },
    ];
    await expect(
      tools.callByName(
        "delete_simulators",
        {
          targets,
          requestId: "bulk-1",
          confirm: true,
        },
        {
          caller: "api-key:key-1@192.0.2.1",
          callerIdentity: ["api-key", "key-1"],
          correlationId: "request-1",
          source: "MCP",
        },
      ),
    ).resolves.toMatchObject({
      structuredContent: {
        targets: [
          { jobId: "job-1" },
          { jobId: null, error: "Agent is offline" },
        ],
      },
    });
    expect(deleteSelected).toHaveBeenCalledExactlyOnceWith(targets, "bulk-1", {
      source: "MCP",
      requestScope: ["api-key", "key-1"],
    });
  });

  test.each([
    ["erase_simulator", { ...device, confirm: false }],
    [
      "delete_simulators",
      { targets: [{ agentId, simulatorId }], requestId: "bulk-1" },
    ],
    ["reset_simulators", request],
  ])("requires explicit confirmation for %s", async (name, input) => {
    const { tools, enqueue, deleteSelected } = registry();
    await expect(tools.callByName(name, input)).rejects.toThrow("confirm");
    expect(enqueue).not.toHaveBeenCalled();
    expect(deleteSelected).not.toHaveBeenCalled();
  });
});
