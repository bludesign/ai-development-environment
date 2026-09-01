import { describe, expect, test, vi } from "vitest";

import type { BuiltInToolGroup } from "../builtin-tools";
import { createSseToolGroup } from "./sse";

function tool(group: BuiltInToolGroup, name: string) {
  return group.tools.find((candidate) => candidate.name === name)!;
}

describe("SSE MCP tools", () => {
  test("creates parameterized templates through the save tool", async () => {
    const saveEventTemplate = vi.fn().mockResolvedValue({ id: "template-1" });
    const group = createSseToolGroup({ saveEventTemplate } as never);
    const fields = [
      {
        id: "field-1",
        key: "count",
        label: "Count",
        helpText: "Retry interval",
        type: "NUMBER" as const,
        required: true,
        defaultValue: null,
      },
    ];

    await tool(group, "sse_mock_template_save").invoke({
      endpointId: "endpoint-1",
      name: "Counter",
      eventName: "counter",
      data: '{"count":{{json:count}}}',
      retryMsTemplate: "{{count}}",
      fields,
    });

    expect(saveEventTemplate).toHaveBeenCalledWith("endpoint-1", {
      name: "Counter",
      eventName: "counter",
      data: '{"count":{{json:count}}}',
      retryMsTemplate: "{{count}}",
      fields,
    });
  });

  test("passes per-block values through saved and ad hoc composition schemas", async () => {
    const saveComposition = vi.fn().mockResolvedValue({ id: "composition-1" });
    const resolveBreakpoint = vi.fn().mockResolvedValue({ id: "breakpoint-1" });
    const group = createSseToolGroup({
      saveComposition,
      resolveBreakpoint,
    } as never);
    const composition = {
      name: "Two greetings",
      blocks: [
        {
          kind: "EVENT" as const,
          templateId: "template-1",
          templateValues: [{ fieldId: "field-1", value: "Ada" }],
        },
        {
          kind: "EVENT" as const,
          templateId: "template-1",
          templateValues: [{ fieldId: "field-1", value: "Grace" }],
        },
      ],
    };

    await tool(group, "sse_mock_composition_save").invoke({
      endpointId: "endpoint-1",
      id: null,
      composition,
    });

    expect(saveComposition).toHaveBeenCalledWith(
      "endpoint-1",
      composition,
      null,
    );

    await tool(group, "sse_breakpoint_resolve").invoke({
      id: "breakpoint-1",
      version: 1,
      resolution: "AD_HOC",
      adHocComposition: composition,
    });
    expect(resolveBreakpoint).toHaveBeenCalledWith({
      id: "breakpoint-1",
      version: 1,
      resolution: "AD_HOC",
      adHocComposition: composition,
    });
  });

  test("rejects incompatible MCP field values before invoking the service", async () => {
    const saveEventTemplate = vi.fn();
    const group = createSseToolGroup({ saveEventTemplate } as never);

    await expect(
      tool(group, "sse_mock_template_save").invoke({
        endpointId: "endpoint-1",
        name: "Invalid",
        data: "{{count}}",
        fields: [
          {
            key: "count",
            label: "Count",
            type: "NOT_A_TYPE",
            required: true,
          },
        ],
      }),
    ).rejects.toThrow();
    expect(saveEventTemplate).not.toHaveBeenCalled();
  });
});
