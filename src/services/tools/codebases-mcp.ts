import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  GetCodebaseInputSchema,
  GetCodebaseOutputSchema,
  GetCodebasesInputSchema,
  GetCodebasesOutputSchema,
  type CodebaseToolsService,
} from "@/services/codebases";
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
  type BuildsService,
} from "@/services/builds";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function result(structuredContent: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

export function createCodebasesMcpServer(
  codebaseTools: CodebaseToolsService,
  builds?: BuildsService,
): McpServer {
  const server = new McpServer({
    name: "ai-development-environment",
    version: "0.1.0",
  });

  server.registerTool(
    "get_codebases",
    {
      title: "Get codebases",
      description:
        "List basic information for every registered codebase checkout.",
      inputSchema: GetCodebasesInputSchema,
      outputSchema: GetCodebasesOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const structuredContent = GetCodebasesOutputSchema.parse({
        codebases: await codebaseTools.list(),
      });
      return result(structuredContent);
    },
  );

  server.registerTool(
    "get_codebase",
    {
      title: "Get codebase",
      description:
        "Get one registered codebase checkout by its exact folder path.",
      inputSchema: GetCodebaseInputSchema,
      outputSchema: GetCodebaseOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ path }) => {
      const structuredContent = GetCodebaseOutputSchema.parse({
        codebase: await codebaseTools.getByPath(path),
      });
      return result(structuredContent);
    },
  );

  if (builds)
    server.registerTool(
      "get_builds",
      {
        title: "Get builds",
        description:
          "List immutable iOS build records across codebases and worktrees.",
        inputSchema: GetBuildsInputSchema,
        outputSchema: GetBuildsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async (input) => {
        const page = await builds.builds(input);
        return result(
          GetBuildsOutputSchema.parse({
            builds: page.items,
            nextCursor: page.nextCursor,
          }) as Record<string, unknown>,
        );
      },
    );

  if (builds)
    server.registerTool(
      "get_build",
      {
        title: "Get build",
        description:
          "Get one build with sanitized structured logs and artifacts.",
        inputSchema: GetBuildInputSchema,
        outputSchema: GetBuildOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ buildId, afterLogId, logLimit }) => {
        const build = await builds.getBuild(buildId);
        if (!build) throw new Error("Build not found");
        return result(
          GetBuildOutputSchema.parse({
            build,
            logs: await builds.logs(buildId, afterLogId, logLimit),
          }) as Record<string, unknown>,
        );
      },
    );

  if (builds)
    server.registerTool(
      "get_build_configurations",
      {
        title: "Get build configurations",
        description:
          "List the shared iOS build configurations available to a worktree.",
        inputSchema: GetBuildConfigurationsInputSchema,
        outputSchema: GetBuildConfigurationsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async ({ worktreeId }) =>
        result(
          GetBuildConfigurationsOutputSchema.parse({
            project: await builds.projectForWorktree(worktreeId),
          }) as Record<string, unknown>,
        ),
    );

  if (builds)
    server.registerTool(
      "get_build_destinations",
      {
        title: "Get build destinations",
        description:
          "Inspect currently available compatible simulators and physical devices.",
        inputSchema: GetBuildDestinationsInputSchema,
        outputSchema: GetBuildDestinationsOutputSchema,
        annotations: READ_ONLY_ANNOTATIONS,
      },
      async (input) =>
        result(
          GetBuildDestinationsOutputSchema.parse({
            destinations:
              "buildId" in input
                ? await builds.destinationsForBuild(
                    input.buildId,
                    input.requestId,
                  )
                : await builds.destinations(input as never),
          }) as Record<string, unknown>,
        ),
    );

  if (builds)
    server.registerTool(
      "start_build",
      {
        title: "Start build",
        description:
          "Queue an immutable iOS build for a selected worktree and destination.",
        inputSchema: StartBuildToolInputSchema,
        outputSchema: StartBuildToolOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) =>
        result(
          StartBuildToolOutputSchema.parse({
            build: await builds.startBuild(input as never),
          }) as Record<string, unknown>,
        ),
    );

  if (builds)
    server.registerTool(
      "cancel_build",
      {
        title: "Cancel build",
        description: "Cancel a queued or active iOS build.",
        inputSchema: CancelBuildToolInputSchema,
        outputSchema: CancelBuildToolOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ buildId }) =>
        result(
          CancelBuildToolOutputSchema.parse({
            build: await builds.cancelBuild(buildId),
          }) as Record<string, unknown>,
        ),
    );

  if (builds)
    server.registerTool(
      "run_build",
      {
        title: "Run build",
        description:
          "Install and launch a completed build without rebuilding it.",
        inputSchema: RunBuildToolInputSchema,
        outputSchema: RunBuildToolOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) =>
        result(
          RunBuildToolOutputSchema.parse({
            deployments: await builds.runBuild(input),
          }) as Record<string, unknown>,
        ),
    );

  if (builds)
    server.registerTool(
      "export_build_archive",
      {
        title: "Export build archive",
        description: "Export a completed Xcode archive to a local IPA folder.",
        inputSchema: ExportBuildToolInputSchema,
        outputSchema: ExportBuildToolOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) =>
        result(
          ExportBuildToolOutputSchema.parse({
            export: await builds.exportArchive(input),
          }) as Record<string, unknown>,
        ),
    );

  return server;
}
