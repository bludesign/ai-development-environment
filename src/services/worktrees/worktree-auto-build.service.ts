import { randomUUID } from "node:crypto";
import { AUTO_BUILD_CHECKOUT_CHANGED } from "@ai-development-environment/agent-contract/builds";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  activeAutomaticBuild,
  type AutomaticBuildSettings,
  type BuildsService,
} from "@/services/builds/builds.service";

const RECONCILE_INTERVAL_MS = 15_000;
const QUEUE_BUILD_FAILED = "QUEUE_FAILED";

const availableCheckout = {
  availability: "AVAILABLE",
  missingAt: null,
  headSha: { not: null },
  lastCheckedAt: { not: null },
  hasStagedChanges: false,
  hasUnstagedChanges: false,
  rebaseInProgress: false,
  hasConflicts: false,
} satisfies Prisma.WorktreeWhereInput;

const unsubmittedBuild = {
  ...activeAutomaticBuild,
  jobId: null,
  queuePayloadJson: { not: null },
} satisfies Prisma.BuildWhereInput;

const autoBuildInclude = {
  worktree: {
    select: {
      id: true,
      codebaseId: true,
      branch: true,
      headSha: true,
      lastCheckedAt: true,
    },
  },
  lastQueuedBuild: {
    select: {
      id: true,
      requestId: true,
      worktreeId: true,
      codebaseId: true,
      agentId: true,
      queuePayloadJson: true,
      jobId: true,
      destinationType: true,
      status: true,
      errorCode: true,
      finishedAt: true,
    },
  },
} satisfies Prisma.WorktreeAutoBuildInclude;

type Rule = Prisma.WorktreeAutoBuildGetPayload<{
  include: typeof autoBuildInclude;
}>;

function pendingSubmission(build: Rule["lastQueuedBuild"]) {
  if (
    build &&
    activeAutomaticBuild.status.in.includes(build.status) &&
    !build.jobId &&
    build.queuePayloadJson
  )
    return build;
  return null;
}

export class WorktreeAutoBuildService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private started = false;
  private rerun = false;

  constructor(
    private readonly builds: Pick<
      BuildsService,
      | "validateAutomaticBuildSettings"
      | "startAutomaticBuild"
      | "resumeAutomaticBuild"
    >,
    private readonly publish: (
      worktreeId: string,
      codebaseId: string | null,
    ) => void,
  ) {}

  startRuntime(): void {
    if (this.started) return;
    this.started = true;
    this.requestReconcile();
  }

  requestReconcile(): void {
    if (!this.started) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile();
    }, delay);
    this.timer.unref();
  }

  async get(worktreeId: string) {
    const prisma = await getPrismaClient();
    return prisma.worktreeAutoBuild.findUnique({ where: { worktreeId } });
  }

  async configure(settings: AutomaticBuildSettings) {
    const worktree = await this.builds.validateAutomaticBuildSettings(settings);
    const prisma = await getPrismaClient();
    const rule = await prisma.$transaction(async (transaction) => {
      const current = await transaction.worktreeAutoBuild.findUnique({
        where: { worktreeId: worktree.id },
      });
      if (
        current?.configurationId === settings.configurationId &&
        current.platform === settings.platform &&
        current.destinationType === settings.destinationType
      ) {
        return current;
      }
      const checkout = await transaction.worktree.findUniqueOrThrow({
        where: { id: worktree.id, missingAt: null, availability: "AVAILABLE" },
        select: { headSha: true },
      });
      const values = {
        configurationId: settings.configurationId,
        platform: settings.platform,
        destinationType: settings.destinationType,
        generation: randomUUID(),
        lastHandledHeadSha: checkout.headSha,
        lastQueuedHeadSha: null,
        lastQueuedObservationAt: null,
        lastQueuedBuildId: null,
        lastError: null,
      };
      return transaction.worktreeAutoBuild.upsert({
        where: { worktreeId: worktree.id },
        create: { worktreeId: worktree.id, ...values },
        update: values,
      });
    });
    this.publish(worktree.id, worktree.codebaseId);
    return rule;
  }

  async cancel(worktreeId: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const { count } = await prisma.worktreeAutoBuild.deleteMany({
      where: { worktreeId },
    });
    if (count) this.publish(worktreeId, null);
    return count > 0;
  }

  async reconcile(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.rerun = false;
    try {
      const prisma = await getPrismaClient();
      const rules = await prisma.worktreeAutoBuild.findMany({
        where: {
          worktree: availableCheckout,
          OR: [
            { worktree: { cleanForAutoBuild: true } },
            // Captured jobs already carry the agent-side checkout guard,
            // including jobs saved before strict readiness reports existed.
            { lastQueuedBuild: unsubmittedBuild },
          ],
        },
        include: autoBuildInclude,
      });
      for (const rule of rules) await this.reconcileRule(rule);

      // A rule can be edited or removed after a build record is committed but
      // before its job is attached. Finish submitting that existing build.
      const orphanedSubmissions = await prisma.build.findMany({
        where: {
          ...unsubmittedBuild,
          worktree: availableCheckout,
          autoBuildRules: { none: {} },
        },
      });
      for (const build of orphanedSubmissions) {
        await this.builds
          .resumeAutomaticBuild(build)
          .catch((error: unknown) => {
            console.error("Could not resume automatic build submission", error);
          });
      }
    } catch (error) {
      console.error("Automatic build reconciliation failed", error);
    } finally {
      this.running = false;
      if (this.started) this.schedule(this.rerun ? 0 : RECONCILE_INTERVAL_MS);
    }
  }

  private async reconcileRule(rule: Rule): Promise<void> {
    const { worktree, lastQueuedBuild } = rule;
    if (!worktree.headSha) return;

    const pending = pendingSubmission(lastQueuedBuild);
    const retryFromNewObservation =
      lastQueuedBuild?.finishedAt &&
      worktree.lastCheckedAt &&
      (!rule.lastQueuedObservationAt ||
        worktree.lastCheckedAt > rule.lastQueuedObservationAt) &&
      (lastQueuedBuild.errorCode === AUTO_BUILD_CHECKOUT_CHANGED ||
        lastQueuedBuild.errorCode === QUEUE_BUILD_FAILED);
    if (!pending) {
      if (
        rule.lastHandledHeadSha === worktree.headSha &&
        !retryFromNewObservation
      )
        return;
      const prisma = await getPrismaClient();
      const active = await prisma.build.findFirst({
        where: { worktreeId: worktree.id, ...activeAutomaticBuild },
        select: { id: true },
      });
      if (active) return;
    }

    try {
      const build = pending
        ? await this.builds.resumeAutomaticBuild(pending)
        : await this.builds.startAutomaticBuild(
            {
              worktreeId: rule.worktreeId,
              configurationId: rule.configurationId,
              platform: rule.platform as AutomaticBuildSettings["platform"],
              destinationType:
                rule.destinationType as AutomaticBuildSettings["destinationType"],
            },
            {
              generation: rule.generation,
              headSha: worktree.headSha,
              branch: worktree.branch,
              queuedBuildCount: rule.queuedBuildCount,
            },
          );
      if (build) {
        if (pending && rule.lastError) {
          const prisma = await getPrismaClient();
          await prisma.worktreeAutoBuild.updateMany({
            where: {
              worktreeId: rule.worktreeId,
              generation: rule.generation,
              lastQueuedBuildId: build.id,
            },
            data: { lastError: null },
          });
        }
        this.publish(worktree.id, worktree.codebaseId);
      }
    } catch (error) {
      const lastError = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 2_000);
      if (lastError !== rule.lastError) {
        const prisma = await getPrismaClient();
        const updated = await prisma.worktreeAutoBuild.updateMany({
          where: {
            worktreeId: rule.worktreeId,
            generation: rule.generation,
            OR: [
              { queuedBuildCount: rule.queuedBuildCount },
              {
                queuedBuildCount: rule.queuedBuildCount + 1,
                lastQueuedBuild: {
                  errorCode: QUEUE_BUILD_FAILED,
                  error: lastError,
                },
              },
            ],
          },
          data: { lastError },
        });
        if (updated.count) this.publish(worktree.id, worktree.codebaseId);
      }
    }
  }
}
