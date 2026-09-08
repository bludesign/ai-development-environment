import type {
  ToolCatalogGroup,
  ToolCatalogSummaryGroup,
} from "@/services/tools/types";
import { getServerServices } from "@/services/server-services";
import { authorizeToolRequest } from "@/services/tools";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request): Promise<Response> {
  const authorization = await authorizeToolRequest(request, "TOOLS_PAGE");
  if ("response" in authorization) return authorization.response;
  try {
    const params = new URL(request.url).searchParams;
    const groupId = params.get("groupId") ?? undefined;
    const name = params.get("name");
    const source = groupId
      ? groupId.startsWith("builtin:")
        ? "BUILTIN"
        : "EXTERNAL"
      : params.get("source");
    if (source && source !== "BUILTIN" && source !== "EXTERNAL") {
      return Response.json(
        { error: { message: "Invalid catalog source" } },
        { status: 400 },
      );
    }
    const catalog = await getServerServices().toolsService.catalog({
      source:
        source === "BUILTIN" || source === "EXTERNAL" ? source : undefined,
      groupId,
      reuse: Boolean(name),
    });
    if (groupId && name) {
      const find = (
        groups: ToolCatalogGroup[],
      ): ToolCatalogGroup | undefined => {
        for (const group of groups) {
          if (group.id === groupId) return group;
          const child = find(group.children);
          if (child) return child;
        }
      };
      const tool = find(catalog.groups)?.tools.find(
        (value) => value.name === name,
      );
      if (!tool)
        return Response.json(
          { error: { message: "Tool not found" } },
          { status: 404 },
        );
      return Response.json({ tool });
    }
    if (params.get("summary") === "1") {
      const summary = (group: ToolCatalogGroup): ToolCatalogSummaryGroup => ({
        ...group,
        tools: group.tools.map(({ name, title, description, annotations }) => ({
          name,
          title,
          description,
          annotations,
        })),
        children: group.children.map(summary),
      });
      return Response.json({ groups: catalog.groups.map(summary) });
    }
    return Response.json(catalog);
  } catch (error) {
    console.error("Tool catalog request failed:", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      { status: 500 },
    );
  }
}
