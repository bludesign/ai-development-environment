import {
  normalizeOperationResources,
  sourceBranchResource,
  type OperationDescriptor,
  type OperationResource,
} from "@ai-development-environment/agent-contract/operation-resources";
import { WORKTREE_POST_MERGE_SWITCH_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import {
  ANDROID_BUILD_DELETE_JOB_KIND,
  ANDROID_DEPLOY_JOB_KIND,
  ANDROID_REMOTE_DEPLOY_JOB_KIND,
  ANDROID_ARTIFACT_DOWNLOAD_JOB_KIND,
  ANDROID_ARTIFACT_TRANSFER_UPLOAD_JOB_KIND,
  ANDROID_RUN_DESTINATIONS_JOB_KIND,
  ANDROID_SOURCE_DISCOVER_JOB_KIND,
  ANDROID_SOURCE_INSPECT_JOB_KIND,
  isBuildRunJob,
} from "@ai-development-environment/agent-contract/builds";
import {
  SIMULATOR_ACTION_JOB_KIND,
  SIMULATOR_CREATE_JOB_KIND,
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_RESET_JOB_KIND,
  simulatorActionPayload,
  simulatorInspectPayload,
} from "@ai-development-environment/agent-contract/simulators";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import { posix, win32 } from "node:path";

export type JobResourceInput = {
  agentId: string;
  kind: string;
  payload: unknown;
  codebaseId?: string | null;
  worktreeId?: string | null;
  blocksGitOperations?: boolean;
};

export function worktreeOperationResource(
  target: { gitDirectory: string; codebaseId: string },
  agentId: string,
  mode: OperationResource["mode"],
): OperationResource {
  return {
    kind: "WORKTREE",
    key: `${agentId}:worktree:${target.gitDirectory}`,
    mode,
    agentId,
    codebaseId: target.codebaseId,
  };
}

/** Inputs have already passed the job-kind parser; registered identities remain authoritative. */
export async function jobOperationDescriptor(
  input: JobResourceInput,
  capable: boolean,
  client?: Pick<Prisma.TransactionClient, "worktree">,
): Promise<OperationDescriptor> {
  const p =
    input.payload && typeof input.payload === "object"
      ? (input.payload as Record<string, unknown>)
      : {};
  const context = {
    agentId: input.agentId,
    ...(input.codebaseId ? { codebaseId: input.codebaseId } : {}),
  };
  const barrier = (): OperationResource[] =>
    input.codebaseId
      ? [
          {
            kind: "CODEBASE",
            key: `${input.agentId}:codebase:${input.codebaseId}`,
            mode: "WRITE",
            ...context,
          },
        ]
      : [
          {
            kind: "AGENT",
            key: `agent:${input.agentId}`,
            mode: "WRITE",
            ...context,
          },
        ];
  const command =
    input.kind === "command.run" || input.kind === "workflow.terminal.run";
  if (command && !input.blocksGitOperations)
    return { version: 1, resources: [] };
  if (!capable)
    return {
      version: 1,
      resources: input.codebaseId || command ? barrier() : [],
    };
  const resources: OperationResource[] = [];
  if (input.kind === SIMULATOR_RESET_JOB_KIND)
    return { version: 1, resources: barrier() };
  if (
    input.kind === SIMULATOR_INVENTORY_JOB_KIND ||
    input.kind === SIMULATOR_CREATE_JOB_KIND ||
    input.kind === SIMULATOR_INSPECT_JOB_KIND ||
    input.kind === SIMULATOR_ACTION_JOB_KIND
  ) {
    const action =
      input.kind === SIMULATOR_ACTION_JOB_KIND
        ? simulatorActionPayload(p)
        : null;
    const changesRoster =
      input.kind === SIMULATOR_CREATE_JOB_KIND ||
      action?.action === "CLONE" ||
      (action?.platform === "ANDROID" && action.action === "RENAME") ||
      action?.action === "DELETE";
    resources.push({
      kind: "DESTINATION",
      key: `${input.agentId}:${p.platform === "ANDROID" ? "android-" : ""}simulator-set`,
      mode: changesRoster ? "WRITE" : "READ",
      ...context,
    });
    const simulatorId =
      action?.simulatorId ??
      (input.kind === SIMULATOR_INSPECT_JOB_KIND
        ? simulatorInspectPayload(p).simulatorId
        : null);
    if (simulatorId)
      resources.push({
        kind: "DESTINATION",
        key: `${input.agentId}:destination:SIMULATOR:${simulatorId}`,
        mode: !action || action.action.startsWith("OPEN_") ? "READ" : "WRITE",
        ...context,
      });
    return { version: 1, resources: normalizeOperationResources(resources) };
  }
  if (input.kind === "jira.branch.generate") return { version: 1, resources };
  if (
    !input.codebaseId &&
    !input.worktreeId &&
    !p.gitDirectory &&
    !p.folder &&
    !p.cwd &&
    !p.worktrees &&
    !p.artifactDirectory &&
    !p.artifactRoot &&
    !p.destination &&
    !p.deployments &&
    !p.targets
  )
    return { version: 1, resources: command ? barrier() : resources };
  const artifact =
    typeof p.artifactDirectory === "string" ? p.artifactDirectory : null;
  const isBuild = isBuildRunJob(input.kind);
  const artifactOnly = [
    "ios.build.delete",
    "ios.artifact.download",
    "ios.build.deploy",
    "ios.agentRunDestinations.inspect",
    "ios.artifact.transfer.upload",
    "ios.build.remoteDeploy",
    "ios.archive.export",
    "ios.test-results.parse",
    "ios.coverage.generate",
    "ios.runDestinations.inspect",
    ANDROID_BUILD_DELETE_JOB_KIND,
    ANDROID_DEPLOY_JOB_KIND,
    ANDROID_REMOTE_DEPLOY_JOB_KIND,
    ANDROID_ARTIFACT_DOWNLOAD_JOB_KIND,
    ANDROID_ARTIFACT_TRANSFER_UPLOAD_JOB_KIND,
    ANDROID_RUN_DESTINATIONS_JOB_KIND,
  ].includes(input.kind);
  if (artifact)
    resources.push({
      kind: "PATH",
      key: `${input.agentId}:path:${artifact}`,
      path: artifact,
      mode:
        isBuild ||
        input.kind === "ios.build.delete" ||
        input.kind === ANDROID_BUILD_DELETE_JOB_KIND ||
        input.kind === "ios.archive.export" ||
        input.kind === "ios.test-results.parse" ||
        input.kind === "ios.coverage.generate"
          ? "WRITE"
          : "READ",
      ...context,
    });
  if (
    input.kind === "ios.build.remoteDeploy" &&
    typeof p.artifactRoot === "string"
  )
    resources.push({
      kind: "PATH",
      key: `${input.agentId}:path:${p.artifactRoot}`,
      path: p.artifactRoot,
      mode: "WRITE",
      ...context,
    });
  const destinations = [
    p.destination,
    ...(Array.isArray(p.deployments)
      ? p.deployments.map((entry) =>
          entry && typeof entry === "object"
            ? (entry as Record<string, unknown>).destination
            : null,
        )
      : []),
  ];
  for (const candidate of destinations) {
    const destination =
      candidate && typeof candidate === "object"
        ? (candidate as Record<string, unknown>)
        : null;
    if (
      destination &&
      typeof destination.id === "string" &&
      !destination.generic &&
      (input.kind.includes("deploy") ||
        input.kind.includes("Deploy") ||
        (isBuild &&
          ["TEST", "TEST_WITHOUT_BUILDING"].includes(String(p.action))))
    ) {
      resources.push({
        kind: "DESTINATION",
        key: `${input.agentId}:destination:${destination.type ?? "SIMULATOR"}:${destination.id}`,
        mode: "WRITE",
        ...context,
      });
    }
  }
  if (artifactOnly)
    return { version: 1, resources: normalizeOperationResources(resources) };
  if (input.kind === "buildData.delete" || input.kind === "buildData.size") {
    const targets = Array.isArray(p.targets)
      ? (p.targets as Array<Record<string, unknown>>)
      : [];
    for (const target of targets)
      if (typeof target.path === "string")
        resources.push({
          kind: "PATH",
          key: `${input.agentId}:path:${target.path}`,
          path: target.path,
          mode: input.kind.endsWith("delete") ? "WRITE" : "READ",
          ...context,
        });
    return { version: 1, resources: normalizeOperationResources(resources) };
  }
  if (
    input.kind === "buildData.scan" ||
    [
      "codebase.fetch",
      "codebase.branches.delete",
      "codebase.browse",
      "codebase.clone.inspect",
      "jira.branch.generate",
    ].includes(input.kind)
  )
    return {
      version: 1,
      resources: [
        ...resources,
        {
          kind: "METADATA",
          key: `${input.agentId}:repository-access:${input.codebaseId ?? input.kind}`,
          mode: "INTENT",
          ...context,
        },
      ],
    };
  if (p.operation === "OPEN_EDITOR" || input.kind === "worktree.watch")
    return { version: 1, resources };
  const read =
    (input.kind.includes("inspect") &&
      input.kind !== ANDROID_SOURCE_INSPECT_JOB_KIND) ||
    input.kind === "codebase.refresh" ||
    input.kind === "worktree.diff.asset" ||
    input.kind === "ios.source.discover" ||
    input.kind === ANDROID_SOURCE_DISCOVER_JOB_KIND ||
    input.kind === "ios.source.parse" ||
    (input.kind === "worktree.prepare" && p.action === "INSPECT");
  const mode = isBuild ? "BUILD" : read ? "READ" : "WRITE";
  const prisma = client ?? (await getPrismaClient());
  const targets = Array.isArray(p.worktrees)
    ? (p.worktrees as Array<Record<string, unknown>>)
    : [p];
  for (const target of targets) {
    const targetId =
      typeof target.worktreeId === "string"
        ? target.worktreeId
        : input.worktreeId;
    const targetGit =
      typeof target.gitDirectory === "string" ? target.gitDirectory : null;
    const targetFolder =
      typeof target.folder === "string"
        ? target.folder
        : typeof p.cwd === "string"
          ? p.cwd
          : null;
    const worktree = await prisma.worktree.findFirst({
      where: {
        ...(targetId
          ? { id: targetId }
          : targetGit
            ? { gitDirectory: targetGit }
            : { folder: targetFolder ?? "" }),
        codebase: { agentId: input.agentId },
      },
      include: { codebase: { include: { repository: true } } },
    });
    if (!worktree) {
      if (read && targetFolder) {
        resources.push({
          kind: "PATH",
          key: `${input.agentId}:path:${targetFolder}`,
          path: targetFolder,
          mode: "READ",
          ...context,
        });
        continue;
      }
      if (
        (input.kind === "worktree.branch" && p.action === "CREATE") ||
        (input.kind === "worktree.move.checkout" && p.mode === "NEW")
      ) {
        // No checkout exists yet; the agent reserves the chosen destination and
        // metadata while creating it, before applying any preparations.
        if (typeof p.expectedOrigin === "string") {
          if (typeof p.branch === "string")
            resources.push(sourceBranchResource(p.expectedOrigin, p.branch));
          if (Array.isArray(p.candidates))
            for (const branch of p.candidates)
              if (typeof branch === "string")
                resources.push(sourceBranchResource(p.expectedOrigin, branch));
        }
        if (typeof p.rootFolder === "string") {
          const paths =
            /^[a-z]:[\\/]/i.test(p.rootFolder) ||
            p.rootFolder.startsWith("\\\\")
              ? win32
              : posix;
          const branches =
            typeof p.branch === "string"
              ? [p.branch]
              : Array.isArray(p.candidates)
                ? p.candidates.filter(
                    (branch): branch is string => typeof branch === "string",
                  )
                : [];
          for (const branch of branches) {
            const path = paths.join(
              paths.dirname(p.rootFolder),
              `${paths.basename(p.rootFolder)}-${branch.replaceAll("/", "-")}`,
            );
            resources.push({
              kind: "PATH",
              key: `${input.agentId}:path:${path}`,
              path,
              mode: "WRITE",
              ...context,
            });
          }
        }
        continue;
      }
      return {
        version: 1,
        resources: normalizeOperationResources([...resources, ...barrier()]),
      };
    }
    if (
      (targetGit && targetGit !== worktree.gitDirectory) ||
      (targetFolder && targetFolder !== worktree.folder) ||
      (input.codebaseId && input.codebaseId !== worktree.codebaseId)
    )
      throw new Error("Job target no longer matches its registered worktree");
    if (
      isBuild &&
      ((typeof p.branch === "string" && p.branch !== worktree.branch) ||
        (typeof p.headSha === "string" && p.headSha !== worktree.headSha))
    )
      throw new Error(
        "Build source branch or HEAD changed while queued; start a new build",
      );
    resources.push(worktreeOperationResource(worktree, input.agentId, mode));
    resources.push({
      kind: "PATH",
      key: `${input.agentId}:path:${worktree.folder}`,
      path: worktree.folder,
      mode,
      agentId: input.agentId,
      codebaseId: worktree.codebaseId,
    });
    if (
      input.kind === "worktree.delete" &&
      p.derivedData &&
      typeof p.derivedData === "object"
    ) {
      const managedRoot = (p.derivedData as Record<string, unknown>)
        .managedRoot;
      if (typeof managedRoot === "string") {
        const paths =
          /^[a-z]:[\\/]/i.test(managedRoot) || managedRoot.startsWith("\\\\")
            ? win32
            : posix;
        const path = paths.join(managedRoot, worktree.id);
        resources.push({
          kind: "PATH",
          key: `${input.agentId}:path:${path}`,
          path,
          mode: "WRITE",
          agentId: input.agentId,
          codebaseId: worktree.codebaseId,
        });
      }
    }
    if (
      input.kind === WORKTREE_POST_MERGE_SWITCH_JOB_KIND &&
      typeof p.branch === "string"
    )
      resources.push(
        sourceBranchResource(
          worktree.codebase.repository.canonicalOrigin,
          p.branch,
          "WRITE",
        ),
      );
    if (mode !== "READ" && worktree.branch) {
      resources.push(
        sourceBranchResource(
          worktree.codebase.repository.canonicalOrigin,
          worktree.branch,
        ),
      );
      if (typeof p.branch === "string" && p.branch !== worktree.branch)
        resources.push(
          sourceBranchResource(
            worktree.codebase.repository.canonicalOrigin,
            p.branch,
          ),
        );
      if (Array.isArray(p.candidates))
        for (const branch of p.candidates)
          if (typeof branch === "string")
            resources.push(
              sourceBranchResource(
                worktree.codebase.repository.canonicalOrigin,
                branch,
              ),
            );
    }
  }
  if (isBuild) {
    for (const resource of resources.filter(
      (entry) => entry.kind === "WORKTREE",
    ))
      resources.push({
        ...resource,
        key: resource.key.replace(":worktree:", ":build-stability:"),
        mode: "WRITE",
      });
    const buildDataPath = p.gradleCachePath ?? p.derivedDataPath;
    if (typeof buildDataPath === "string")
      resources.push({
        kind: "PATH",
        key: `${input.agentId}:path:${buildDataPath}`,
        path: buildDataPath,
        mode: "WRITE",
        ...context,
      });
    for (const script of Array.isArray(p.scripts)
      ? (p.scripts as Array<Record<string, unknown>>)
      : []) {
      if (script.lockScope === "AGENT")
        resources.push({
          kind: "AGENT",
          key: `agent:${input.agentId}`,
          mode: "WRITE",
          ...context,
        });
      if (script.lockScope === "CODEBASE") resources.push(...barrier());
    }
  }
  return { version: 1, resources: normalizeOperationResources(resources) };
}
