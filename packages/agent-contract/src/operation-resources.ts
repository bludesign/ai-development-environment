/** Versioned execution resources shared by the control plane and agents. */
export const OPERATION_RESOURCES_CAPABILITY = "operation.resources.v1";

export type OperationResource = {
  kind:
    | "WORKTREE"
    | "CODEBASE"
    | "AGENT"
    | "BRANCH"
    | "ARTIFACT"
    | "DESTINATION"
    | "PATH"
    | "METADATA";
  key: string;
  mode: "READ" | "BUILD" | "WRITE" | "INTENT";
  agentId?: string;
  codebaseId?: string;
  path?: string;
};

export type OperationDescriptor = {
  version: 1;
  resources: OperationResource[];
};

export function normalizeOperationOrigin(origin: string): string {
  let value = origin.trim();
  if (/^\w+:\/\//.test(value)) {
    const url = new URL(value);
    value = `${url.host}${url.pathname}`;
  } else {
    value = value
      .replace(/^[^/@]+@/, "")
      .replace(/^([^/:]+):(?!\d+(?:\/|$))/, "$1/");
  }
  return value
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export function sourceBranchResource(
  origin: string,
  branch: string,
  mode: "INTENT" | "WRITE" = "INTENT",
): OperationResource {
  return {
    kind: "BRANCH",
    key: `branch:${normalizeOperationOrigin(origin)}:${branch}`,
    mode,
  };
}

function normalizedPath(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(value) ? value.toLowerCase() : value || "/";
}

function overlappingPaths(a: string, b: string): boolean {
  const left = normalizedPath(a);
  const right = normalizedPath(b);
  return (
    left === right ||
    left.startsWith(`${right === "/" ? "" : right}/`) ||
    right.startsWith(`${left === "/" ? "" : left}/`)
  );
}

export function operationResourcesConflict(
  a: OperationResource,
  b: OperationResource,
): boolean {
  const agentOverlap = Boolean(
    a.agentId && b.agentId && a.agentId === b.agentId,
  );
  if (
    agentOverlap &&
    ((a.kind === "AGENT" && a.mode === "WRITE") ||
      (b.kind === "AGENT" && b.mode === "WRITE"))
  )
    return true;
  if (
    agentOverlap &&
    a.codebaseId &&
    a.codebaseId === b.codebaseId &&
    ((a.kind === "CODEBASE" && a.mode === "WRITE") ||
      (b.kind === "CODEBASE" && b.mode === "WRITE"))
  )
    return true;
  const same =
    a.kind === b.kind &&
    (a.kind === "PATH"
      ? agentOverlap && overlappingPaths(a.path ?? a.key, b.path ?? b.key)
      : a.key === b.key);
  if (!same) return false;
  if (a.mode === "INTENT" && b.mode === "INTENT") return false;
  if (a.mode === "READ" && (b.mode === "READ" || b.mode === "BUILD"))
    return false;
  if (b.mode === "READ" && a.mode === "BUILD") return false;
  return true;
}

export function operationDescriptorsConflict(
  a: OperationDescriptor,
  b: OperationDescriptor,
): boolean {
  return a.resources.some((left) =>
    b.resources.some((right) => operationResourcesConflict(left, right)),
  );
}

export function normalizeOperationResources(
  resources: OperationResource[],
): OperationResource[] {
  const unique = new Map<string, OperationResource>();
  const strength = { INTENT: 0, READ: 1, BUILD: 2, WRITE: 3 };
  for (const resource of resources) {
    if (
      !resource.key ||
      !resource.kind ||
      !Object.hasOwn(strength, resource.mode)
    )
      throw new Error("Invalid operation resource");
    const id = `${resource.kind}:${resource.key}`;
    const old = unique.get(id);
    if (!old || strength[resource.mode] > strength[old.mode])
      unique.set(id, resource);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`),
  );
}

export function parseOperationDescriptor(value: unknown): OperationDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid operation descriptor");
  const descriptor = value as Record<string, unknown>;
  if (descriptor.version !== 1 || !Array.isArray(descriptor.resources))
    throw new Error("Unsupported operation descriptor");
  const kinds = new Set([
    "WORKTREE",
    "CODEBASE",
    "AGENT",
    "BRANCH",
    "ARTIFACT",
    "DESTINATION",
    "PATH",
    "METADATA",
  ]);
  for (const resource of descriptor.resources) {
    if (
      !resource ||
      typeof resource !== "object" ||
      !kinds.has(resource.kind) ||
      typeof resource.key !== "string" ||
      !["READ", "BUILD", "WRITE", "INTENT"].includes(resource.mode) ||
      [resource.agentId, resource.codebaseId, resource.path].some(
        (field) => field !== undefined && typeof field !== "string",
      )
    )
      throw new Error("Invalid operation resource");
  }
  return {
    version: 1,
    resources: normalizeOperationResources(descriptor.resources),
  };
}
