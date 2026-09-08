import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { WorkflowCatalog } from "./types";

const QUERY = `query WorkflowCatalog {
  workflowCatalog {
    schemaVersion globalConcurrency
    steps { kind category label description details execution configSchema capabilityFlags requiredPaths providedPaths sourceHandles mutatesExternal mutatesWorktree }
    triggers { kind category label description details configSchema capabilityFlags seedPaths sourceHandles }
  }
}`;

// This catalog is code-defined and contains no user or integration data. Cache it
// for this application lifetime; workflow edits do not change the registry.
let cached: WorkflowCatalog | undefined;
let generation = 0;
export function invalidateWorkflowCatalog() {
  cached = undefined;
  ++generation;
}
export async function loadWorkflowCatalog(
  signal?: AbortSignal,
): Promise<WorkflowCatalog> {
  if (signal?.aborted)
    throw new DOMException("The request was aborted", "AbortError");
  if (cached) return cached;
  const version = generation;
  const data = await controlPlaneRequest<{ workflowCatalog: WorkflowCatalog }>(
    QUERY,
    undefined,
    { signal },
  );
  if (signal?.aborted)
    throw new DOMException("The request was aborted", "AbortError");
  if (version === generation) cached = data.workflowCatalog;
  return data.workflowCatalog;
}
