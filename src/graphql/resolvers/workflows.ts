import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  CreateWorkflowInput,
  ImportWorkflowInput,
  SaveWorkflowDraftInput,
  TriggerWorkflowInput,
  WorkflowsService,
} from "@/services/workflows";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId)
    throw new Error("Agent credentials cannot manage workflows");
}

function requireAgent(context: GraphQLContext): string {
  if (!context.agentId) throw new Error("Agent authentication is required");
  return context.agentId;
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const json = (value: string | null | undefined) =>
  value ? JSON.parse(value) : null;

export const createWorkflowResolvers = (service: WorkflowsService) => ({
  Workflow: {
    draftDefinition: (value: { draftDefinitionJson: string }) =>
      JSON.parse(value.draftDefinitionJson),
    versionCount: (value: {
      _count?: { versions?: number };
      versions?: unknown[];
    }) => value._count?.versions ?? value.versions?.length ?? 0,
    runCount: (value: { _count?: { runs?: number } }) =>
      value._count?.runs ?? 0,
    archivedAt: (value: { archivedAt?: Date | null }) => iso(value.archivedAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  WorkflowVersion: {
    definition: (value: { definitionJson: string }) =>
      JSON.parse(value.definitionJson),
    publishedAt: (value: { publishedAt: Date }) =>
      value.publishedAt.toISOString(),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  WorkflowTrigger: {
    config: (value: { configJson: string }) => JSON.parse(value.configJson),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  WorkflowRun: {
    triggerPayload: (value: { triggerPayloadJson: string }) =>
      JSON.parse(value.triggerPayloadJson),
    sessionData: (value: { sessionDataJson: string }) =>
      JSON.parse(value.sessionDataJson),
    attemptCount: (value: {
      _count?: { attempts?: number };
      attempts?: unknown[];
    }) => value._count?.attempts ?? value.attempts?.length ?? 0,
    eventCount: (value: { _count?: { events?: number }; events?: unknown[] }) =>
      value._count?.events ?? value.events?.length ?? 0,
    queuedAt: (value: { queuedAt: Date }) => value.queuedAt.toISOString(),
    startedAt: (value: { startedAt?: Date | null }) => iso(value.startedAt),
    pausedAt: (value: { pausedAt?: Date | null }) => iso(value.pausedAt),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  WorkflowStepAttempt: {
    input: (value: { inputJson?: string | null }) => json(value.inputJson),
    output: (value: { outputJson?: string | null }) => json(value.outputJson),
    requiredPaths: (value: { requiredPathsJson: string }) =>
      JSON.parse(value.requiredPathsJson),
    providedPaths: (value: { providedPathsJson: string }) =>
      JSON.parse(value.providedPathsJson),
    startedAt: (value: { startedAt?: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
    supersededAt: (value: { supersededAt?: Date | null }) =>
      iso(value.supersededAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  WorkflowWait: {
    predicate: (value: { predicateJson?: string | null }) =>
      json(value.predicateJson),
    result: (value: { resultJson?: string | null }) => json(value.resultJson),
    resumeAfter: (value: { resumeAfter?: Date | null }) =>
      iso(value.resumeAfter),
    timeoutAt: (value: { timeoutAt?: Date | null }) => iso(value.timeoutAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    resolvedAt: (value: { resolvedAt?: Date | null }) => iso(value.resolvedAt),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  WorkflowRunEvent: {
    detail: (value: { detailJson?: string | null }) => json(value.detailJson),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  WorkflowRunResourceLink: {
    metadata: (value: { metadataJson?: string | null }) =>
      json(value.metadataJson),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  Query: {
    workflows: (
      _root: unknown,
      args: Parameters<WorkflowsService["list"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.list(args);
    },
    workflow: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.get(id);
    },
    workflowVersion: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.version(id);
    },
    workflowCatalog: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.catalog();
    },
    validateWorkflowDraft: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.validateDraft(id);
    },
    workflowRuns: (
      _root: unknown,
      args: Parameters<WorkflowsService["runs"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.runs(args);
    },
    workflowRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.run(id);
    },
    workflowRunEvents: (
      _root: unknown,
      args: { runId: string; afterSequence?: number; first?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.runEvents(args.runId, args.afterSequence, args.first);
    },
    workflowRunsForResource: (
      _root: unknown,
      args: { kind: string; resourceId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.runsForResource(args.kind, args.resourceId);
    },
    workflowsAcceptingResource: (
      _root: unknown,
      { kind }: { kind: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.acceptingResource(kind);
    },
    exportWorkflow: (
      _root: unknown,
      { id, versionId }: { id: string; versionId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.export(id, versionId);
    },
    prepareWorkflowReplay: (
      _root: unknown,
      args: { runId: string; nodeId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.prepareReplay(args.runId, args.nodeId);
    },
    workflowJobSecrets: (
      _root: unknown,
      { jobId }: { jobId: string },
      context: GraphQLContext,
    ) => service.jobSecrets(requireAgent(context), jobId),
  },
  Mutation: {
    createWorkflow: (
      _root: unknown,
      { input }: { input: CreateWorkflowInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.create(input);
    },
    saveWorkflowDraft: (
      _root: unknown,
      { input }: { input: SaveWorkflowDraftInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveDraft(input);
    },
    importWorkflow: (
      _root: unknown,
      { input }: { input: ImportWorkflowInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.import(input);
    },
    publishWorkflow: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.publish(id);
    },
    setWorkflowEnabled: (
      _root: unknown,
      args: { id: string; enabled: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.setEnabled(args.id, args.enabled);
    },
    archiveWorkflow: (
      _root: unknown,
      args: { id: string; archived: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.archive(args.id, args.archived);
    },
    deleteWorkflow: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.delete(id);
    },
    triggerWorkflow: (
      _root: unknown,
      { input }: { input: TriggerWorkflowInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.trigger(input);
    },
    pauseWorkflowRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.lifecycle(id, "PAUSE");
    },
    resumeWorkflowRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.lifecycle(id, "RESUME");
    },
    cancelWorkflowRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.lifecycle(id, "CANCEL");
    },
    repairWorkflowRunData: (
      _root: unknown,
      { id, patch }: { id: string; patch: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.repairRunData(id, patch);
    },
    answerWorkflowQuestion: (
      _root: unknown,
      { batchId, answers }: { batchId: string; answers: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.answerQuestion(batchId, answers);
    },
    replayWorkflowRun: (
      _root: unknown,
      args: {
        runId: string;
        nodeId: string;
        restore?: boolean | null;
        stash?: boolean | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.replay(args.runId, args.nodeId, args);
    },
  },
  Subscription: {
    workflowsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeWorkflows();
      },
      resolve: (payload: { workflowChanged: { id: string } }) =>
        payload.workflowChanged.id === "runs"
          ? null
          : service.get(payload.workflowChanged.id),
    },
    workflowRunChanged: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeRun(runId);
      },
      resolve: (payload: { workflowRunChanged: { id: string } }) =>
        service.run(payload.workflowRunChanged.id),
    },
    workflowRunEventAdded: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeRunEvents(runId);
      },
    },
    workflowQuestionChanged: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeRunQuestions(runId);
      },
      resolve: (payload: { workflowQuestionChanged: { id: string } }) =>
        service.questionBatch(payload.workflowQuestionChanged.id),
    },
  },
});
