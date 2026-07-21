import * as z from "zod/v4";

import type { AgentControlService } from "@/services/agent-control";
import type { BuildsService } from "@/services/builds";
import type {
  CodebasesService,
  CodebaseToolsService,
} from "@/services/codebases";
import type { PushNotificationsService } from "@/services/push-notifications";
import type { TelemetryService } from "@/services/telemetry";

import { createAgentToolGroup } from "./builtin-tools/agents";
import { createBuildToolGroup } from "./builtin-tools/builds";
import { createCodebaseToolGroup } from "./builtin-tools/codebases";
import { createDebuggingToolGroup } from "./builtin-tools/debugging";
import type { ToolCatalogGroup } from "./types";

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

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
  return new BuiltInToolRegistry(groups);
}
