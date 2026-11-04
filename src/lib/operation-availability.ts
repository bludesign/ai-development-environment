import {
  operationDescriptorsConflict,
  parseOperationDescriptor,
  type OperationDescriptor,
} from "@ai-development-environment/agent-contract/operation-resources";

type Job = {
  status: string;
  kind: string;
  codebaseId?: string | null;
  worktreeId?: string | null;
  blocksGitOperations?: boolean;
  operationResourcesJson?: string | null;
  executionToken?: string | null;
};
type Target = {
  id: string;
  gitDirectory: string;
  codebaseId: string;
  codebase: { agentId: string };
};

export function worktreeAvailabilityDescriptor(
  target: Target,
  mode: "READ" | "WRITE" = "WRITE",
): OperationDescriptor {
  return {
    version: 1,
    resources: [
      {
        kind: "WORKTREE",
        key: `${target.codebase.agentId}:worktree:${target.gitDirectory}`,
        mode,
        agentId: target.codebase.agentId,
        codebaseId: target.codebaseId,
      },
    ],
  };
}

export function jobConflictsWithWorktree(
  job: Job,
  target: Target,
  mode: "READ" | "WRITE" = "WRITE",
): boolean {
  if (!["RUNNING", "CANCELLING"].includes(job.status) && !job.executionToken)
    return false;
  if (job.operationResourcesJson)
    return operationDescriptorsConflict(
      parseOperationDescriptor(JSON.parse(job.operationResourcesJson)),
      worktreeAvailabilityDescriptor(target, mode),
    );
  if (job.codebaseId && job.codebaseId !== target.codebaseId) return false;
  if (
    ["command.run", "workflow.terminal.run"].includes(job.kind) &&
    !job.blocksGitOperations
  )
    return false;
  if (job.kind.startsWith("ios.") && job.kind !== "ios.build.run") return false;
  if (job.kind.includes("inspect") || job.kind === "worktree.watch")
    return false;
  return !(mode === "READ" && job.kind === "ios.build.run");
}

export function jobHasRepositoryBarrier(job: Job): boolean {
  if (!["RUNNING", "CANCELLING"].includes(job.status) && !job.executionToken)
    return false;
  if (job.operationResourcesJson)
    return parseOperationDescriptor(
      JSON.parse(job.operationResourcesJson),
    ).resources.some(
      (resource) =>
        ["CODEBASE", "AGENT"].includes(resource.kind) &&
        resource.mode === "WRITE",
    );
  return (
    !job.kind.startsWith("ios.") &&
    (!["command.run", "workflow.terminal.run"].includes(job.kind) ||
      job.blocksGitOperations === true)
  );
}
