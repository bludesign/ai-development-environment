import { describe, expect, test } from "vitest";

import type { ToolCatalogGroup } from "@/services/tools/types";

import {
  descendantToolNames,
  groupCheckboxState,
} from "./mcp-preset-management";

describe("MCP preset tool tree", () => {
  const group = {
    id: "parent",
    name: "Parent",
    source: "BUILTIN",
    tools: [{ name: "parent_tool" }],
    children: [
      {
        id: "child",
        name: "Child",
        source: "BUILTIN",
        tools: [{ name: "child_tool" }],
        children: [],
      },
    ],
  } as unknown as ToolCatalogGroup;

  test("expands a group to its explicit current descendant tool names", () => {
    expect(descendantToolNames(group)).toEqual(["parent_tool", "child_tool"]);
  });

  test("reports unchecked, indeterminate, and checked group states", () => {
    const names = descendantToolNames(group);
    expect(groupCheckboxState(names, new Set())).toBe(false);
    expect(groupCheckboxState(names, new Set(["child_tool"]))).toBe(
      "indeterminate",
    );
    expect(groupCheckboxState(names, new Set(names))).toBe(true);
  });
});
