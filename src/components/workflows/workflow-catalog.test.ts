import { afterEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  invalidateWorkflowCatalog,
  loadWorkflowCatalog,
} from "./workflow-catalog";
vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
afterEach(() => {
  invalidateWorkflowCatalog();
  vi.resetAllMocks();
});
test("reuses the registry across workflow definitions and refetches after invalidation", async () => {
  const catalog = {
    schemaVersion: 1,
    globalConcurrency: 1,
    steps: [],
    triggers: [],
  };
  request.mockResolvedValue({ workflowCatalog: catalog });
  expect(await loadWorkflowCatalog()).toBe(catalog);
  expect(await loadWorkflowCatalog()).toBe(catalog);
  expect(request).toHaveBeenCalledTimes(1);
  invalidateWorkflowCatalog();
  await loadWorkflowCatalog();
  expect(request).toHaveBeenCalledTimes(2);
});
test("an aborted response does not populate the catalog cache", async () => {
  const controller = new AbortController();
  request.mockImplementationOnce(async () => {
    controller.abort();
    return { workflowCatalog: {} };
  });
  await expect(loadWorkflowCatalog(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  request.mockResolvedValue({ workflowCatalog: { steps: [], triggers: [] } });
  await loadWorkflowCatalog();
  expect(request).toHaveBeenCalledTimes(2);
});
