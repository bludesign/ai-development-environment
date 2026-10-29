import "server-only";

import { WORKFLOW_CAPABILITY_ACTIONS } from "@/lib/workflows/capability-actions";
import type { ToolsService } from "@/services/tools";
import type { WorkflowStepExecutor } from "./step-executor";

export function registerCapabilityActionAdapters(
  executor: WorkflowStepExecutor,
  tools: Pick<ToolsService, "callBuiltInTool">,
): void {
  for (const action of WORKFLOW_CAPABILITY_ACTIONS) {
    executor.register(action.kind, async (context) => {
      const args: Record<string, unknown> = {};
      for (const field of action.fields) {
        const value = context.node.config[field.key];
        if (value !== undefined) args[field.key] = value;
        else if (field.key === "requestId")
          args.requestId = `${context.run.id}:${context.node.id}`;
      }
      const result = await tools.callBuiltInTool(action.toolName, args, {
        caller: `workflow:${context.run.id}`,
        correlationId: context.attempt.id,
        source: "WORKFLOW",
      });
      if ("isError" in result && result.isError)
        throw new Error(`Workflow action ${action.label} failed`);
      const output = result.structuredContent ?? result;
      return {
        output,
        sessionPatch: { steps: { [context.node.id]: { output } } },
      };
    });
  }
}
