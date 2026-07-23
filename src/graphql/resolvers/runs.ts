import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  ImportedRunInput,
  RunConfigurationInput,
  RunEventInput,
  RunQuestionInput,
  RunsService,
  SaveRunDraftInput,
} from "@/services/runs";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) throw new Error("Agent credentials cannot manage runs");
}

function requireAgent(context: GraphQLContext): string {
  if (!context.agentId) throw new Error("Agent authentication is required");
  return context.agentId;
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const json = (value: string | null | undefined) =>
  value ? JSON.parse(value) : null;

export const createRunResolvers = (service: RunsService) => ({
  AgentRun: {
    archivedAt: (value: { archivedAt?: Date | null }) => iso(value.archivedAt),
    nativeArchivedAt: (value: { nativeArchivedAt?: Date | null }) =>
      iso(value.nativeArchivedAt),
    startedAt: (value: { startedAt?: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
    pricingUpdatedAt: (value: { pricingUpdatedAt?: Date | null }) =>
      iso(value.pricingUpdatedAt),
    playedAt: (value: { playedAt?: Date | null }) => iso(value.playedAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  RunAttempt: {
    startedAt: (value: { startedAt: Date }) => value.startedAt.toISOString(),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
    supersededAt: (value: { supersededAt?: Date | null }) =>
      iso(value.supersededAt),
  },
  RunInput: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  RunAttachment: {
    downloadPath: (value: { id: string }) =>
      `/api/run-attachments/${encodeURIComponent(value.id)}`,
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  RunEvent: {
    raw: (value: { rawJson?: string | null }) => json(value.rawJson),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    supersededAt: (value: { supersededAt?: Date | null }) =>
      iso(value.supersededAt),
  },
  RunToolCall: {
    input: (value: { inputJson?: string | null }) => json(value.inputJson),
    output: (value: { outputJson?: string | null }) => json(value.outputJson),
    startedAt: (value: { startedAt: Date }) => value.startedAt.toISOString(),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
    supersededAt: (value: { supersededAt?: Date | null }) =>
      iso(value.supersededAt),
  },
  RunAnswerRevision: {
    answers: (value: { answersJson: string }) => JSON.parse(value.answersJson),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    supersededAt: (value: { supersededAt?: Date | null }) =>
      iso(value.supersededAt),
  },
  RunQuestionBatch: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    answeredAt: (value: { answeredAt?: Date | null }) => iso(value.answeredAt),
    supersededAt: (value: { supersededAt?: Date | null }) =>
      iso(value.supersededAt),
    revisionPreparedAt: (value: { revisionPreparedAt?: Date | null }) =>
      iso(value.revisionPreparedAt),
  },
  RunCheckpoint: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  RunDraft: {
    archivedAt: (value: { archivedAt?: Date | null }) => iso(value.archivedAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  RunCommand: {
    payload: (value: { payloadJson: string }) => JSON.parse(value.payloadJson),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    claimedAt: (value: { claimedAt?: Date | null }) => iso(value.claimedAt),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
  },
  RunProviderImportStatus: {
    catalog: (value: { catalogJson?: string | null }) =>
      json(value.catalogJson),
    lastStartedAt: (value: { lastStartedAt?: Date | null }) =>
      iso(value.lastStartedAt),
    lastCompletedAt: (value: { lastCompletedAt?: Date | null }) =>
      iso(value.lastCompletedAt),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  Query: {
    agentRuns: (
      _root: unknown,
      args: Parameters<RunsService["list"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.list(args);
    },
    agentRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.get(id);
    },
    runEvents: (
      _root: unknown,
      args: Parameters<RunsService["events"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.events(args);
    },
    runQuestionBatches: (
      _root: unknown,
      args: Parameters<RunsService["questions"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.questions(args);
    },
    runUsage: (
      _root: unknown,
      { runId }: { runId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.usage(runId);
    },
    runLinkedItems: (
      _root: unknown,
      { runId }: { runId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.linkedItems(runId);
    },
    runDrafts: (
      _root: unknown,
      args: Parameters<RunsService["drafts"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.drafts(args);
    },
    runDraft: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.draft(id);
    },
    runProviderCatalog: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.providerCatalog();
    },
    runProviderImportStatus: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.providerImportStatus();
    },
    pendingRunCommands: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => service.pendingCommands(requireAgent(context)),
  },
  Mutation: {
    createAgentRun: (
      _root: unknown,
      { input }: { input: RunConfigurationInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.create(input);
    },
    playPlan: (
      _root: unknown,
      { planId }: { planId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.playPlan(planId);
    },
    createRunFollowUp: (
      _root: unknown,
      { sourceId, input }: { sourceId: string; input: RunConfigurationInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.followUp(sourceId, input);
    },
    saveRunDraft: (
      _root: unknown,
      { input }: { input: SaveRunDraftInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveDraft(input);
    },
    archiveAgentRuns: (
      _root: unknown,
      { ids, archived }: { ids: string[]; archived: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.archive(ids, archived);
    },
    deleteAgentRuns: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteRuns(ids);
    },
    archiveRunDrafts: (
      _root: unknown,
      { ids, archived }: { ids: string[]; archived: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.archiveDrafts(ids, archived);
    },
    deleteRunDrafts: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteDrafts(ids);
    },
    pauseAgentRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.lifecycle(id, "PAUSE");
    },
    continueAgentRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.lifecycle(id, "CONTINUE");
    },
    cancelAgentRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.lifecycle(id, "CANCEL");
    },
    steerAgentRun: (
      _root: unknown,
      {
        id,
        prompt,
        attachmentIds,
      }: { id: string; prompt: string; attachmentIds?: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.steer(id, prompt, attachmentIds);
    },
    answerRunQuestion: (
      _root: unknown,
      { batchId, answers }: { batchId: string; answers: unknown },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.answerQuestion(batchId, answers);
    },
    prepareRunAnswerRevision: (
      _root: unknown,
      { batchId }: { batchId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.prepareAnswerRevision(batchId);
    },
    reviseRunAnswer: (
      _root: unknown,
      {
        batchId,
        answers,
        stash,
        rollback,
      }: {
        batchId: string;
        answers: unknown;
        stash?: boolean;
        rollback?: boolean;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.reviseAnswer(
        batchId,
        answers,
        Boolean(stash),
        rollback !== false,
      );
    },
    claimRunCommand: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => service.claimCommand(requireAgent(context), id),
    completeRunCommand: (
      _root: unknown,
      {
        id,
        status,
        error,
      }: { id: string; status: string; error?: string | null },
      context: GraphQLContext,
    ) => service.completeCommand(requireAgent(context), id, status, error),
    beginRunAttempt: (
      _root: unknown,
      { runId, nativeId }: { runId: string; nativeId?: string | null },
      context: GraphQLContext,
    ) => service.beginAttempt(requireAgent(context), runId, nativeId),
    updateRunAttemptNativeId: (
      _root: unknown,
      args: {
        attemptId: string;
        nativeId: string;
        providerVersion?: string | null;
      },
      context: GraphQLContext,
    ) =>
      service.updateAttemptNativeId(
        requireAgent(context),
        args.attemptId,
        args.nativeId,
        args.providerVersion,
      ),
    appendRunEvents: (
      _root: unknown,
      args: {
        runId: string;
        attemptId?: string | null;
        events: RunEventInput[];
      },
      context: GraphQLContext,
    ) =>
      service.appendEvents(
        requireAgent(context),
        args.runId,
        args.attemptId ?? null,
        args.events,
      ),
    reportRunQuestion: (
      _root: unknown,
      args: {
        runId: string;
        attemptId?: string | null;
        nativeRequestId?: string | null;
        eventSequence?: number | null;
        questions: RunQuestionInput[];
      },
      context: GraphQLContext,
    ) =>
      service.reportQuestion(
        requireAgent(context),
        args.runId,
        args.attemptId ?? null,
        args.nativeRequestId ?? null,
        args.eventSequence ?? null,
        args.questions,
      ),
    reportRunUsage: (
      _root: unknown,
      args: {
        runId: string;
        attemptId?: string | null;
        input: Parameters<RunsService["reportUsage"]>[3];
      },
      context: GraphQLContext,
    ) =>
      service.reportUsage(
        requireAgent(context),
        args.runId,
        args.attemptId ?? null,
        args.input,
      ),
    finishRunAttempt: (
      _root: unknown,
      args: {
        attemptId: string;
        input: Parameters<RunsService["finishAttempt"]>[2];
      },
      context: GraphQLContext,
    ) =>
      service.finishAttempt(requireAgent(context), args.attemptId, args.input),
    reportRunCheckpoint: (
      _root: unknown,
      args: {
        runId: string;
        attemptId?: string | null;
        input: Parameters<RunsService["reportCheckpoint"]>[3];
      },
      context: GraphQLContext,
    ) =>
      service.reportCheckpoint(
        requireAgent(context),
        args.runId,
        args.attemptId ?? null,
        args.input,
      ),
    reportRunAnswerRevisionPreview: (
      _root: unknown,
      args: {
        batchId: string;
        rollbackPatch: string;
        pushedCommitWarning?: string | null;
      },
      context: GraphQLContext,
    ) =>
      service.reportAnswerRevisionPreview(
        requireAgent(context),
        args.batchId,
        args.rollbackPatch,
        args.pushedCommitWarning,
      ),
    applyRunAnswerRevision: (
      _root: unknown,
      args: {
        batchId: string;
        revisionId: string;
        replacementAttemptId: string;
      },
      context: GraphQLContext,
    ) =>
      service.applyAnswerRevision(
        requireAgent(context),
        args.batchId,
        args.revisionId,
        args.replacementAttemptId,
      ),
    importProviderRuns: (
      _root: unknown,
      { provider, runs }: { provider: string; runs: ImportedRunInput[] },
      context: GraphQLContext,
    ) => service.importRuns(requireAgent(context), provider, runs),
    reportRunProviderImportStatus: (
      _root: unknown,
      args: {
        provider: string;
        status: string;
        error?: string | null;
        catalog?: unknown;
      },
      context: GraphQLContext,
    ) =>
      service.reportProviderImportStatus(
        requireAgent(context),
        args.provider,
        args.status,
        args.error,
        args.catalog,
      ),
  },
  Subscription: {
    agentRunsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribeRuns();
      },
      resolve: (payload: { runChanged: { id: string } }) =>
        service.get(payload.runChanged.id),
    },
    agentRunChanged: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeRun(runId);
      },
      resolve: (payload: { runChanged: { id: string } }) =>
        service.get(payload.runChanged.id),
    },
    runEventAdded: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeEvents(runId);
      },
    },
    runQuestionChanged: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeQuestions(runId);
      },
      resolve: (payload: { runQuestionChanged: { id: string } }) =>
        service.questionBatch(payload.runQuestionChanged.id),
    },
  },
});
