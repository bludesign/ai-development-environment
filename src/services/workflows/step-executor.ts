import "server-only";

import type {
  WorkflowRun,
  WorkflowStepAttempt,
} from "@/generated/prisma/client";
import type {
  WorkflowNodeDefinition,
  WorkflowStepKind,
} from "@/lib/workflows/definition";
import type { SessionData } from "@/lib/workflows/session";

export type WorkflowResourceLinkInput = {
  kind: string;
  resourceId: string;
  label?: string | null;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type WorkflowWaitInput = {
  kind: string;
  externalKey?: string | null;
  predicate?: Record<string, unknown> | null;
  resumeAfter?: Date | null;
  timeoutAt?: Date | null;
};

export type WorkflowExecutionResult = {
  output?: unknown;
  sessionPatch?: SessionData;
  selectedHandles?: string[];
  links?: WorkflowResourceLinkInput[];
  wait?: WorkflowWaitInput;
};

export type WorkflowExecutionContext = {
  run: WorkflowRun;
  attempt: WorkflowStepAttempt;
  node: WorkflowNodeDefinition;
  sessionData: SessionData;
  signal: AbortSignal;
};

export type WorkflowStepHandler = (
  context: WorkflowExecutionContext,
) => Promise<WorkflowExecutionResult>;

export class WorkflowStepExecutor {
  private readonly handlers = new Map<WorkflowStepKind, WorkflowStepHandler>();

  register(kind: WorkflowStepKind, handler: WorkflowStepHandler): void {
    this.handlers.set(kind, handler);
  }

  has(kind: WorkflowStepKind): boolean {
    return this.handlers.has(kind);
  }

  execute(context: WorkflowExecutionContext): Promise<WorkflowExecutionResult> {
    const handler = this.handlers.get(context.node.kind);
    if (!handler) {
      throw new Error(`Workflow step ${context.node.kind} is not registered`);
    }
    return handler(context);
  }
}
