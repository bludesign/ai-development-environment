import * as z from "zod/v4";

import type { AgentControlService } from "@/services/agent-control";
import type { BuildsService } from "@/services/builds";
import type { BuildDataService } from "@/services/build-data";
import type { CacheServerService } from "@/services/cache-server";
import type { CcusageService } from "@/services/ccusage";
import type {
  CodebasesService,
  CodebaseToolsService,
} from "@/services/codebases";
import type { DiskSpaceService } from "@/services/disk-space";
import type { CredentialService } from "@/services/credentials";
import type { CommandsService } from "@/services/commands";
import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { JiraService, JiraWebhookService } from "@/services/jira";
import type { IosDevicesService } from "@/services/ios-devices";
import type { ModelCostsService } from "@/services/model-costs";
import type { NotificationsService } from "@/services/notifications";
import type { PollingService } from "@/services/polling";
import type { SigningAssetsService } from "@/services/signing-assets";
import type { SkillsService } from "@/services/skills";
import type { SystemStatusService } from "@/services/system-status";
import type { PushNotificationsService } from "@/services/push-notifications";
import type { TelemetryService } from "@/services/telemetry";
import type { RunsService } from "@/services/runs";
import type { WorkflowsService } from "@/services/workflows";
import type {
  WorktreeAutomationService,
  WorktreesService,
} from "@/services/worktrees";

import { createAgentToolGroup } from "./builtin-tools/agents";
import { createBuildToolGroup } from "./builtin-tools/builds";
import { createBuildDataToolGroup } from "./builtin-tools/build-data";
import { createCacheAdministrationGroup } from "./builtin-tools/cache-administration";
import { createCodebaseToolGroup } from "./builtin-tools/codebases";
import { createDebuggingToolGroup } from "./builtin-tools/debugging";
import { createDiskSpaceToolGroup } from "./builtin-tools/disk-space";
import { createCommandToolGroup } from "./builtin-tools/commands";
import { createGitHubToolGroup } from "./builtin-tools/github";
import { createGitLabToolGroup } from "./builtin-tools/gitlab";
import { createJiraToolGroup } from "./builtin-tools/jira";
import { createIosDeviceToolGroup } from "./builtin-tools/ios-devices";
import { createNotificationToolGroup } from "./builtin-tools/notifications";
import { createRunToolGroup } from "./builtin-tools/runs";
import { createSigningAssetToolGroup } from "./builtin-tools/signing-assets";
import { createSkillToolGroup } from "./builtin-tools/skills";
import { createSystemToolGroup } from "./builtin-tools/system";
import { createUsageCostToolGroup } from "./builtin-tools/usage-costs";
import { createWorkflowToolGroup } from "./builtin-tools/workflows";
import { createWorktreeToolGroup } from "./builtin-tools/worktrees";
import { createToolAdministrationGroup } from "./builtin-tools/tool-administration";
import type { ToolCallAuditService } from "./tool-call-audit.service";
import { createWorktreeAutomationToolGroup } from "./builtin-tools/worktree-automations";
import type { ToolAnnotations, ToolCatalogGroup } from "./types";

export type { ToolAnnotations } from "./types";

export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const DESTRUCTIVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export const READ_ONLY_EXTERNAL_ANNOTATIONS: ToolAnnotations = {
  ...READ_ONLY_ANNOTATIONS,
  openWorldHint: true,
};

export const WRITE_EXTERNAL_ANNOTATIONS: ToolAnnotations = {
  ...WRITE_ANNOTATIONS,
  openWorldHint: true,
};

export const DESTRUCTIVE_EXTERNAL_ANNOTATIONS: ToolAnnotations = {
  ...DESTRUCTIVE_ANNOTATIONS,
  openWorldHint: true,
};

export type BuiltInToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  invoke: (input: unknown) => Promise<unknown>;
};

export type BuiltInToolGroup = {
  id: string;
  name: string;
  tools: BuiltInToolDefinition[];
  children: BuiltInToolGroup[];
};

export type BuiltInToolServices = {
  codebaseTools: CodebaseToolsService;
  builds?: BuildsService;
  codebases?: CodebasesService;
  telemetry?: TelemetryService;
  pushNotifications?: PushNotificationsService;
  agents?: AgentControlService;
  diskSpace?: DiskSpaceService;
  worktrees?: WorktreesService;
  runs?: RunsService;
  commands?: CommandsService;
  jira?: JiraService;
  jiraWebhooks?: JiraWebhookService;
  github?: GitHubService;
  gitlab?: GitLabService;
  buildData?: BuildDataService;
  cacheServer?: CacheServerService;
  ccusage?: CcusageService;
  credentials?: CredentialService;
  iosDevices?: IosDevicesService;
  modelCosts?: ModelCostsService;
  notifications?: NotificationsService;
  polling?: PollingService;
  signingAssets?: SigningAssetsService;
  skills?: SkillsService;
  systemStatus?: SystemStatusService;
  toolAudit?: ToolCallAuditService;
  testExternalMcpServer?: (id: string) => Promise<unknown>;
  /**
   * Supplied as a thunk rather than an instance: `WorkflowsService` is
   * constructed after `ToolsService` and takes it as a dependency, so the two
   * cannot both be resolved at construction time. Called only when a workflow
   * tool is invoked.
   */
  workflows?: () => WorkflowsService;
  worktreeAutomations?: () => WorktreeAutomationService;
};

export function defineTool<I extends z.ZodType, O extends z.ZodType>(input: {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  annotations?: ToolAnnotations;
  handler: (value: z.output<I>) => Promise<unknown> | unknown;
}): BuiltInToolDefinition {
  return {
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    annotations: input.annotations ?? READ_ONLY_ANNOTATIONS,
    invoke: async (value) => {
      const parsed = input.inputSchema.parse(value) as z.output<I>;
      return input.outputSchema.parse(await input.handler(parsed));
    },
  };
}

type IndexedTool = { groupId: string; definition: BuiltInToolDefinition };

function flattenGroups(groups: BuiltInToolGroup[]): IndexedTool[] {
  return groups.flatMap((group) => [
    ...group.tools.map((definition) => ({ groupId: group.id, definition })),
    ...flattenGroups(group.children),
  ]);
}

function catalogGroup(group: BuiltInToolGroup): ToolCatalogGroup {
  return {
    id: group.id,
    name: group.name,
    source: "BUILTIN",
    transport: null,
    url: null,
    error: null,
    tools: group.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(tool.outputSchema) as Record<
        string,
        unknown
      >,
      annotations: tool.annotations,
    })),
    children: group.children.map(catalogGroup),
  };
}

function toolResult(structuredContent: unknown) {
  if (
    !structuredContent ||
    typeof structuredContent !== "object" ||
    Array.isArray(structuredContent)
  ) {
    throw new Error("Built-in tool output must be a JSON object");
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent: structuredContent as Record<string, unknown>,
  };
}

export class BuiltInToolRegistry {
  private readonly indexed: IndexedTool[];
  private readonly byName: Map<string, IndexedTool>;
  private readonly groupIds: Set<string>;

  constructor(private readonly groups: BuiltInToolGroup[]) {
    this.indexed = flattenGroups(groups);
    this.byName = new Map();
    this.groupIds = new Set();
    const visit = (group: BuiltInToolGroup) => {
      if (this.groupIds.has(group.id)) {
        throw new Error(`Duplicate built-in tool group id: ${group.id}`);
      }
      this.groupIds.add(group.id);
      group.children.forEach(visit);
    };
    groups.forEach(visit);
    for (const indexed of this.indexed) {
      if (this.byName.has(indexed.definition.name)) {
        throw new Error(
          `Duplicate built-in MCP tool name: ${indexed.definition.name}`,
        );
      }
      this.byName.set(indexed.definition.name, indexed);
    }
  }

  definitions(): BuiltInToolDefinition[] {
    return this.indexed.map(({ definition }) => definition);
  }

  catalog(): ToolCatalogGroup[] {
    return this.groups.map(catalogGroup);
  }

  hasGroup(groupId: string): boolean {
    return this.groupIds.has(groupId);
  }

  groupIdForName(name: string): string | null {
    return this.byName.get(name)?.groupId ?? null;
  }

  async call(groupId: string, name: string, args: unknown) {
    const indexed = this.byName.get(name);
    if (!indexed || indexed.groupId !== groupId) {
      throw new Error(`Unknown built-in tool: ${name}`);
    }
    return toolResult(await indexed.definition.invoke(args));
  }

  async callByName(name: string, args: unknown) {
    const indexed = this.byName.get(name);
    if (!indexed) throw new Error(`Unknown built-in tool: ${name}`);
    return toolResult(await indexed.definition.invoke(args));
  }
}

export function createBuiltInToolRegistry(
  services: BuiltInToolServices,
): BuiltInToolRegistry {
  const groups: BuiltInToolGroup[] = [
    createCodebaseToolGroup(services.codebaseTools, services.codebases),
  ];
  if (services.builds) groups.push(createBuildToolGroup(services.builds));
  if (services.telemetry && services.pushNotifications) {
    groups.push(
      createDebuggingToolGroup(services.telemetry, services.pushNotifications),
    );
  }
  if (services.agents) groups.push(createAgentToolGroup(services.agents));
  if (services.diskSpace)
    groups.push(createDiskSpaceToolGroup(services.diskSpace));
  if (services.worktrees)
    groups.push(createWorktreeToolGroup(services.worktrees));
  if (services.runs) groups.push(createRunToolGroup(services.runs));
  if (services.commands) groups.push(createCommandToolGroup(services.commands));
  if (services.jira && services.jiraWebhooks)
    groups.push(createJiraToolGroup(services.jira, services.jiraWebhooks));
  if (services.github) groups.push(createGitHubToolGroup(services.github));
  if (services.gitlab) groups.push(createGitLabToolGroup(services.gitlab));
  if (services.skills) groups.push(createSkillToolGroup(services.skills));
  if (services.buildData)
    groups.push(createBuildDataToolGroup(services.buildData));
  if (services.signingAssets)
    groups.push(createSigningAssetToolGroup(services.signingAssets));
  if (services.iosDevices)
    groups.push(createIosDeviceToolGroup(services.iosDevices));
  if (services.notifications)
    groups.push(createNotificationToolGroup(services.notifications));
  if (services.ccusage && services.modelCosts)
    groups.push(
      createUsageCostToolGroup(services.ccusage, services.modelCosts),
    );
  if (services.systemStatus && services.polling && services.credentials)
    groups.push(
      createSystemToolGroup(
        services.systemStatus,
        services.polling,
        services.credentials,
      ),
    );
  if (services.cacheServer && services.jira && services.github)
    groups.push(
      createCacheAdministrationGroup(
        services.cacheServer,
        services.jira,
        services.github,
        services.gitlab,
      ),
    );
  if (services.toolAudit && services.testExternalMcpServer) {
    groups.push(
      createToolAdministrationGroup(
        services.toolAudit,
        services.testExternalMcpServer,
      ),
    );
  }
  if (services.workflows)
    groups.push(createWorkflowToolGroup(services.workflows));
  if (services.worktreeAutomations) {
    groups.push(
      createWorktreeAutomationToolGroup(services.worktreeAutomations),
    );
  }
  return new BuiltInToolRegistry(groups);
}
