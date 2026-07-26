import * as z from "zod/v4";

import type { SkillsService } from "@/services/skills";

import {
  DESTRUCTIVE_ANNOTATIONS,
  defineTool,
  WRITE_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { redactSensitiveToolOutput, serviceTool } from "./service-tool";

export function createSkillToolGroup(service: SkillsService): BuiltInToolGroup {
  return {
    id: "builtin:skills",
    name: "Skills",
    children: [],
    tools: [
      serviceTool({
        name: "get_skills_overview",
        title: "Get skills overview",
        description: "List skills, groups, installations, and sync status.",
        inputSchema: z.object({ search: z.string().default("") }),
        service,
        method: "overview",
        arguments: ({ search }) => [search],
        resultKey: "overview",
      }),
      serviceTool({
        name: "get_skill",
        title: "Get skill",
        description: "Get one skill and its deployments.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "getSkill",
        arguments: ({ id }) => [id],
        resultKey: "skill",
      }),
      defineTool({
        name: "get_skill_groups",
        title: "Get skill groups",
        description: "Get skill groups, optionally for one repository.",
        inputSchema: z.object({
          repositoryId: z.string().nullable().optional(),
        }),
        outputSchema: z.object({ groups: z.unknown() }),
        handler: async ({ repositoryId }) => ({
          groups: redactSensitiveToolOutput(
            repositoryId
              ? await service.groupsForRepository(repositoryId)
              : (await service.overview()).groups,
          ),
        }),
      }),
      serviceTool({
        name: "get_skill_sync_run",
        title: "Get skill sync run",
        description: "Inspect a skill synchronization run and its conflicts.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "getRun",
        arguments: ({ id }) => [id],
        resultKey: "run",
      }),
      serviceTool({
        name: "save_skill",
        title: "Save skill",
        description: "Create or update a managed skill.",
        inputSchema: z.object({ input: z.record(z.string(), z.unknown()) }),
        service,
        method: "saveSkill",
        arguments: ({ input }) => [input],
        resultKey: "skill",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_skill",
        title: "Delete skill",
        description: "Delete a managed skill and its associations.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "deleteSkill",
        arguments: ({ id }) => [id],
        resultKey: "deleted",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "save_skill_group",
        title: "Save skill group",
        description: "Create or update a managed skill group.",
        inputSchema: z.object({ input: z.record(z.string(), z.unknown()) }),
        service,
        method: "saveGroup",
        arguments: ({ input }) => [input],
        resultKey: "group",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "delete_skill_group",
        title: "Delete skill group",
        description: "Delete a managed skill group.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service,
        method: "deleteGroup",
        arguments: ({ id }) => [id],
        resultKey: "deleted",
        annotations: DESTRUCTIVE_ANNOTATIONS,
      }),
      serviceTool({
        name: "update_skill_settings",
        title: "Update skill settings",
        description:
          "Update managed skill locations and reconciliation settings.",
        inputSchema: z.object({ input: z.record(z.string(), z.unknown()) }),
        service,
        method: "saveSettings",
        arguments: ({ input }) => [input],
        resultKey: "settings",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "prepare_skill_sync",
        title: "Prepare skill sync",
        description: "Prepare a push or pull skill synchronization run.",
        inputSchema: z.object({
          kind: z.enum(["ALL", "GROUP"]),
          groupId: z.string().nullable().optional(),
        }),
        service,
        method: "prepareSync",
        arguments: ({ kind, groupId }) => [kind, groupId ?? null],
        resultKey: "run",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "resolve_skill_sync_conflict",
        title: "Resolve skill sync conflict",
        description:
          "Choose a resolution for one skill synchronization conflict.",
        inputSchema: z.object({ input: z.record(z.string(), z.unknown()) }),
        service,
        method: "resolveItem",
        arguments: ({ input }) => [input],
        resultKey: "run",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "skip_skill_sync",
        title: "Skip skill sync",
        description:
          "Skip remaining pending work in a skill synchronization run.",
        inputSchema: z.object({ runId: z.string().min(1) }),
        service,
        method: "skipPending",
        arguments: ({ runId }) => [runId],
        resultKey: "run",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "apply_skill_sync",
        title: "Apply skill sync",
        description:
          "Apply all resolved items in a prepared skill synchronization run.",
        inputSchema: z.object({ runId: z.string().min(1) }),
        service,
        method: "applyRun",
        arguments: ({ runId }) => [runId],
        resultKey: "run",
        annotations: WRITE_ANNOTATIONS,
      }),
    ],
  };
}
