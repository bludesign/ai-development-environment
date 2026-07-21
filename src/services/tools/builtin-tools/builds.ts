import type { BuildsService } from "@/services/builds";
import {
  CancelBuildToolInputSchema,
  CancelBuildToolOutputSchema,
  ExportBuildToolInputSchema,
  ExportBuildToolOutputSchema,
  GetBuildConfigurationsInputSchema,
  GetBuildConfigurationsOutputSchema,
  GetBuildDestinationsInputSchema,
  GetBuildDestinationsOutputSchema,
  GetBuildInputSchema,
  GetBuildOutputSchema,
  GetBuildsInputSchema,
  GetBuildsOutputSchema,
  RunBuildToolInputSchema,
  RunBuildToolOutputSchema,
  StartBuildToolInputSchema,
  StartBuildToolOutputSchema,
} from "@/services/builds";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";

export function createBuildToolGroup(builds: BuildsService): BuiltInToolGroup {
  return {
    id: "builtin:builds",
    name: "Builds",
    children: [],
    tools: [
      defineTool({
        name: "get_builds",
        title: "Get builds",
        description: "List immutable iOS build records.",
        inputSchema: GetBuildsInputSchema,
        outputSchema: GetBuildsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async (input) => {
          const page = await builds.builds(input);
          return { builds: page.items, nextCursor: page.nextCursor };
        },
      }),
      defineTool({
        name: "get_build",
        title: "Get build",
        description: "Get a build with sanitized logs.",
        inputSchema: GetBuildInputSchema,
        outputSchema: GetBuildOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ buildId, afterLogId, logLimit }) => {
          const build = await builds.getBuild(buildId);
          if (!build) throw new Error("Build not found");
          return {
            build,
            logs: await builds.logs(buildId, afterLogId, logLimit),
          };
        },
      }),
      defineTool({
        name: "get_build_configurations",
        title: "Get build configurations",
        description: "List build configurations for a worktree.",
        inputSchema: GetBuildConfigurationsInputSchema,
        outputSchema: GetBuildConfigurationsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ worktreeId }) => ({
          project: await builds.projectForWorktree(worktreeId),
        }),
      }),
      defineTool({
        name: "get_build_destinations",
        title: "Get build destinations",
        description: "Inspect compatible build destinations.",
        inputSchema: GetBuildDestinationsInputSchema,
        outputSchema: GetBuildDestinationsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async (input) => ({
          destinations:
            "buildId" in input
              ? await builds.destinationsForBuild(
                  input.buildId,
                  input.requestId,
                )
              : await builds.destinations(input as never),
        }),
      }),
      defineTool({
        name: "start_build",
        title: "Start build",
        description: "Queue an iOS build.",
        inputSchema: StartBuildToolInputSchema,
        outputSchema: StartBuildToolOutputSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          build: await builds.startBuild(input as never),
        }),
      }),
      defineTool({
        name: "cancel_build",
        title: "Cancel build",
        description: "Cancel an active build.",
        inputSchema: CancelBuildToolInputSchema,
        outputSchema: CancelBuildToolOutputSchema,
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ buildId }) => ({
          build: await builds.cancelBuild(buildId),
        }),
      }),
      defineTool({
        name: "run_build",
        title: "Run build",
        description: "Install and launch without rebuilding.",
        inputSchema: RunBuildToolInputSchema,
        outputSchema: RunBuildToolOutputSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          deployments: await builds.runBuild(input),
        }),
      }),
      defineTool({
        name: "export_build_archive",
        title: "Export build archive",
        description: "Export an archive to a local IPA folder.",
        inputSchema: ExportBuildToolInputSchema,
        outputSchema: ExportBuildToolOutputSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          export: await builds.exportArchive(input),
        }),
      }),
    ],
  };
}
