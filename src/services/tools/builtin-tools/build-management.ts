import * as z from "zod/v4";
import type { BuildsService } from "@/services/builds";
import {
  DESTRUCTIVE_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
} from "../builtin-tools";
import { redactSensitiveToolOutput } from "./service-tool";

const Id = z.string().trim().min(1).max(256);
const SigningOptions = z.object({
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  identities: z.array(
    z.object({
      sha1: z.string(),
      name: z.string(),
      teamId: z.string().nullable(),
    }),
  ),
  profiles: z.array(
    z.object({
      uuid: z.string(),
      name: z.string(),
      teamId: z.string().nullable(),
      teamName: z.string().nullable(),
      bundleId: z.string(),
      type: z.string(),
      platforms: z.array(z.string()),
      expiresAt: z.string().nullable(),
      expired: z.boolean(),
      xcodeManaged: z.boolean(),
      certificateSha1s: z.array(z.string()),
    }),
  ),
  bundles: z.array(
    z.object({
      bundleId: z.string(),
      name: z.string(),
      relativePath: z.string(),
      embeddedProfileUuid: z.string().nullable(),
      embeddedProfileName: z.string().nullable(),
    }),
  ),
});
const Observation = z.object({
  id: z.string(),
  scopeKey: z.string(),
  status: z.string(),
  schemes: z.array(z.string()),
  configurations: z.array(z.string()),
  testPlans: z.array(z.string()),
  error: z.string().nullable(),
  stale: z.boolean(),
  headSha: z.string().nullable(),
  xcodeVersion: z.string().nullable(),
  lastParseAttemptAt: z.string(),
  lastParsedAt: z.string().nullable(),
});
function strings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
export function createBuildManagementTools(service: BuildsService) {
  return [
    defineTool({
      name: "delete_build_project",
      title: "Delete build project",
      description:
        "Delete an iOS build project and its configuration from the repository.",
      inputSchema: z.object({ id: Id }),
      outputSchema: z.object({ deleted: z.boolean() }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
      handler: async ({ id }) => ({ deleted: await service.deleteProject(id) }),
    }),
    defineTool({
      name: "reparse_build_configuration",
      title: "Reparse build configuration",
      description:
        "Reinspect a saved configuration in the chosen worktree and return its source observation, including validation errors.",
      inputSchema: z.object({
        configurationId: Id,
        worktreeId: Id,
        requestId: Id,
      }),
      outputSchema: z.object({ observation: Observation }),
      annotations: WRITE_ANNOTATIONS,
      handler: async ({ configurationId, worktreeId, requestId }) => {
        const row = await service.reparse(
          configurationId,
          worktreeId,
          requestId,
        );
        return {
          observation: {
            ...(redactSensitiveToolOutput(row) as object),
            schemes: strings(row.schemesJson),
            configurations: strings(row.configurationsJson),
            testPlans: strings(row.testPlansJson),
          },
        };
      },
    }),
    defineTool({
      name: "set_codebase_build_scripts",
      title: "Set codebase build scripts",
      description:
        "Replace the ordered reusable scripts allowed for the codebase's repository. An empty list removes all assignments.",
      inputSchema: z.object({
        codebaseId: Id,
        scriptIds: z.array(Id).max(500),
      }),
      outputSchema: z.object({
        project: z
          .object({
            id: z.string(),
            type: z.string(),
            repositoryId: z.string(),
            allowedScripts: z.array(
              z.object({
                position: z.number().int(),
                script: z.object({ id: z.string(), name: z.string() }),
              }),
            ),
          })
          .nullable(),
      }),
      annotations: WRITE_ANNOTATIONS,
      handler: async ({ codebaseId, scriptIds }) => ({
        project: await service.setAllowedScripts(codebaseId, scriptIds),
      }),
    }),
    defineTool({
      name: "get_build_signing_options",
      title: "Get build signing options",
      description:
        "Inspect teams, certificate fingerprints, profiles and archive bundle mappings on the build agent. Private keys and profile bytes are excluded.",
      inputSchema: z.object({ buildId: Id }),
      outputSchema: z.object({ options: SigningOptions }),
      annotations: WRITE_ANNOTATIONS,
      handler: async ({ buildId }) => ({
        options: await service.signingOptionsForBuild(buildId),
      }),
    }),
    defineTool({
      name: "get_build_run_agents",
      title: "Get build run agents",
      description:
        "List deployment agents for a successful runnable build and explain any availability restrictions.",
      inputSchema: z.object({ buildId: Id }),
      outputSchema: z.object({
        agents: z.array(
          z.object({
            agent: z.object({
              id: z.string(),
              name: z.string(),
              hostname: z.string(),
              architecture: z.string(),
              osVersion: z.string(),
            }),
            isBuildAgent: z.boolean(),
            available: z.boolean(),
            unavailableReason: z.string().nullable(),
          }),
        ),
      }),
      handler: async ({ buildId }) => ({
        agents: await service.runAgentsForBuild(buildId),
      }),
    }),
  ];
}
