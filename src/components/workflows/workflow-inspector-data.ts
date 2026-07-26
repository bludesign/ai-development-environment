import type { WorkflowPathLookup } from "@/lib/workflows/definition";
import {
  expandSessionPaths,
  type SessionFieldInfo,
} from "@/lib/workflows/session-schema";

import type {
  WorkflowCatalog,
  WorkflowCatalogEntry,
  WorkflowTriggerCatalogEntry,
} from "./types";

/** Path lookup backed by the GraphQL catalog, for the reachability walk. */
export function buildPathLookup(
  catalog: WorkflowCatalog | null,
): WorkflowPathLookup {
  const steps = new Map(
    catalog?.steps.map((entry) => [entry.kind, entry]) ?? [],
  );
  const triggers = new Map(
    catalog?.triggers.map((entry) => [entry.kind, entry]) ?? [],
  );
  return {
    stepPaths: (kind) => {
      const entry = steps.get(kind as WorkflowCatalogEntry["kind"]);
      return {
        requiredPaths: entry?.requiredPaths ?? [],
        providedPaths: entry?.providedPaths ?? [],
      };
    },
    triggerSeedPaths: (kind) =>
      triggers.get(kind as WorkflowTriggerCatalogEntry["kind"])?.seedPaths ??
      [],
  };
}

/** Concrete session paths a step contributes, without its bookkeeping path. */
export function displayProvidedPaths(
  nodeId: string,
  provides: Map<string, string[]>,
): SessionFieldInfo[] {
  const all = provides.get(nodeId) ?? [];
  const domain = all.filter((path) => path !== `steps.${nodeId}.*`);
  return expandSessionPaths(domain.length ? domain : all);
}

export function providesByNodeMap(availability: {
  provides: Map<string, string[]>;
}): Map<string, string[]> {
  return new Map(
    [...availability.provides.keys()].map((nodeId) => [
      nodeId,
      displayProvidedPaths(nodeId, availability.provides).map(
        (info) => info.path,
      ),
    ]),
  );
}
