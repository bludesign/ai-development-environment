import type { ToolCatalogSummaryGroup } from "@/services/tools/types";

export type PresetToolReference = {
  source: "BUILTIN" | "EXTERNAL";
  name: string;
  serverId?: string | null;
  serverName?: string | null;
};

export function toolReferenceKey(tool: PresetToolReference): string {
  return JSON.stringify([tool.source, tool.serverId ?? null, tool.name]);
}

export function catalogSelections(group: ToolCatalogSummaryGroup): Array<{
  key: string;
  reference: PresetToolReference;
  label: string;
}> {
  return [
    ...group.tools.flatMap((tool) => {
      const reference =
        (tool as typeof tool & { reference?: PresetToolReference }).reference ??
        (group.source === "BUILTIN"
          ? { source: "BUILTIN" as const, name: tool.name }
          : null);
      return reference
        ? [
            {
              key: toolReferenceKey(reference),
              reference,
              label: tool.title || tool.name,
            },
          ]
        : [];
    }),
    ...group.children.flatMap(catalogSelections),
  ];
}

export function presetToolInput(tool: PresetToolReference) {
  return {
    source: tool.source,
    name: tool.name,
    ...(tool.source === "EXTERNAL" ? { serverId: tool.serverId } : {}),
  };
}
