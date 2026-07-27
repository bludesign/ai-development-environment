import type { PrismaClient } from "../../src/generated/prisma/client";

import { HIGHLIGHTS } from "./codebases";
import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

/**
 * Notifications snapshot their worktree's highlight color when they are recorded (see
 * `recordInTransaction` callers such as builds.service.ts), so every row that carries a
 * `worktreeId` also carries the matching `HIGHLIGHTS` entry — the sidebar card and the
 * history table both key their accent stripe off `highlightColor`, not off the relation.
 * Rows whose resource has no worktree (a workflow run without one, an agent, a skill sync)
 * stay unhighlighted, which is what the notifications table should show for them.
 */
export async function seedNotifications(prisma: PrismaClient): Promise<void> {
  await prisma.appNotification.createMany({
    data: [
      // Six live sidebar cards: still requested, never dismissed, each one worktree-tinted.
      {
        id: ids.notifications.buildFailed,
        dedupeKey: "build-failed-ios-test-1",
        typeKey: "build.failed",
        title: "Build failed",
        body: "TEST build for acme/ios-app failed with 3 test failures.",
        href: `/builds/${ids.builds.test}`,
        resourceKind: "BUILD",
        resourceId: ids.builds.test,
        worktreeId: ids.worktrees.iosMain,
        highlightColor: HIGHLIGHTS.iosMain,
        sidebarRequested: true,
        browserRequested: true,
        webPushRequested: false,
        createdAt: minutesAgo(44),
      },
      {
        id: "notification-pr-review",
        dedupeKey: "pr-review-web-42",
        typeKey: "pull_request.review_requested",
        title: "Review requested",
        body: "acme/web-app#42 “Add quick search” is waiting for review.",
        href: "/pull-requests/acme/web-app/42",
        resourceKind: "PULL_REQUEST",
        resourceId: "acme/web-app#42",
        worktreeId: ids.worktrees.webFeature,
        highlightColor: HIGHLIGHTS.webFeature,
        sidebarRequested: true,
        browserRequested: false,
        webPushRequested: true,
        createdAt: hoursAgo(2),
      },
      {
        id: "notification-run-complete",
        dedupeKey: "run-complete-2001",
        typeKey: "run.completed",
        title: "Session completed",
        body: "Session #2001 finished on acme/web-app.",
        href: `/sessions/${ids.runs.sessionSearch}`,
        resourceKind: "AGENT_RUN",
        resourceId: ids.runs.sessionSearch,
        worktreeId: ids.worktrees.webFeature,
        highlightColor: HIGHLIGHTS.webFeature,
        sidebarRequested: true,
        browserRequested: false,
        webPushRequested: false,
        createdAt: daysAgo(4),
      },
      {
        id: "notification-question-asked",
        dedupeKey: "run-question-1003",
        typeKey: "run.question_asked",
        title: "Answer needed",
        body: "Plan #1003 is waiting on a decision about gift cards.",
        href: `/plans/${ids.runs.planCheckoutQuestion}`,
        resourceKind: "AGENT_RUN",
        resourceId: ids.runs.planCheckoutQuestion,
        worktreeId: ids.worktrees.webFeature,
        highlightColor: HIGHLIGHTS.webFeature,
        sidebarRequested: true,
        browserRequested: true,
        webPushRequested: true,
        createdAt: minutesAgo(21),
      },
      {
        id: "notification-deployment-complete",
        dedupeKey: "deployment-complete-testflight-1",
        typeKey: "build.deployed",
        title: "Deployed to TestFlight",
        body: "acme/ios-app archive 3.4.1 (3410) finished uploading.",
        href: `/builds/${ids.builds.archive}`,
        resourceKind: "BUILD",
        resourceId: ids.builds.archive,
        worktreeId: ids.worktrees.iosMain,
        highlightColor: HIGHLIGHTS.iosMain,
        sidebarRequested: true,
        browserRequested: true,
        webPushRequested: true,
        createdAt: hoursAgo(3),
      },
      {
        id: "notification-pipeline-failed",
        dedupeKey: "pipeline-failed-web-412",
        typeKey: "pull_request.pipeline_failed",
        title: "Pipeline failed",
        body: "Test run 412 failed on acme/web-app#42.",
        href: "/pull-requests/acme/web-app/42",
        resourceKind: "PULL_REQUEST",
        resourceId: "acme/web-app#42",
        worktreeId: ids.worktrees.webFeature,
        highlightColor: HIGHLIGHTS.webFeature,
        sidebarRequested: true,
        browserRequested: false,
        webPushRequested: true,
        createdAt: hoursAgo(4),
      },
      /**
       * History-only rows. They carry channel flags so the Notifications table shows the
       * Channels column populated, but each is already dismissed so the app-shell sidebar —
       * which reads `sidebarRequested: true, sidebarDismissedAt: null` — keeps the same six
       * cards it shows in every other screenshot.
       */
      {
        id: "notification-command-complete",
        dedupeKey: "command-complete-3001",
        typeKey: "command.succeeded",
        title: "Command succeeded",
        body: "“Run Tests” completed successfully on Studio Mac.",
        href: `/commands/runs/${ids.commandRuns.latest}`,
        resourceKind: "COMMAND_RUN",
        resourceId: ids.commandRuns.latest,
        worktreeId: ids.worktrees.webMain,
        highlightColor: HIGHLIGHTS.webMain,
        sidebarRequested: false,
        browserRequested: false,
        webPushRequested: false,
        sidebarDismissedAt: minutesAgo(9),
        createdAt: minutesAgo(11),
      },
      /**
       * The remaining rows stay unhighlighted on purpose: this workflow run's session data
       * carries no worktree, and agents and skill syncs are not worktree-scoped at all.
       */
      {
        id: "notification-workflow-succeeded",
        dedupeKey: "workflow-succeeded-4001",
        typeKey: "workflow.succeeded",
        title: "Workflow succeeded",
        body: "PR Review Assistant #4001 finished on acme/web-app.",
        href: `/workflows/runs/${ids.workflowRuns.latest}`,
        resourceKind: "WORKFLOW_RUN",
        resourceId: ids.workflowRuns.latest,
        sidebarRequested: true,
        browserRequested: true,
        webPushRequested: false,
        sidebarDismissedAt: minutesAgo(30),
        createdAt: minutesAgo(34),
      },
      {
        id: "notification-agent-offline",
        dedupeKey: "agent-offline-ci-runner",
        typeKey: "agent.offline",
        title: "Agent went offline",
        body: "CI Runner stopped reporting 6 hours ago.",
        href: `/agents/${ids.agents.ci}`,
        resourceKind: "AGENT",
        resourceId: ids.agents.ci,
        sidebarRequested: true,
        browserRequested: false,
        webPushRequested: false,
        sidebarDismissedAt: hoursAgo(5),
        createdAt: hoursAgo(6),
      },
      {
        id: "notification-skill-sync",
        dedupeKey: "skill-sync-core-engineering",
        typeKey: "skill.synced",
        title: "Skills synced",
        body: "Core Engineering pushed 3 skills to Studio Mac.",
        href: `/skills/sync/${ids.skillSyncRuns.latest}`,
        resourceKind: "SKILL_SYNC_RUN",
        resourceId: ids.skillSyncRuns.latest,
        sidebarRequested: true,
        browserRequested: false,
        webPushRequested: false,
        sidebarDismissedAt: daysAgo(1),
        createdAt: daysAgo(1),
      },
    ],
  });

  await prisma.pushNotificationPreset.create({
    data: {
      id: ids.push.preset,
      name: "Release Announcement",
      editorJson: JSON.stringify({
        title: "New release available",
        body: "Acme 3.5 is now available with quick search.",
      }),
    },
  });

  await prisma.apnsCertificateCredential.create({
    data: {
      id: "apns-cert-acme",
      name: "Acme Production APNs",
      topic: "com.acme.app",
      environment: "PRODUCTION",
      fingerprint: "SHA256:acmeApnsCert1234567890",
      expiresAt: daysAgo(-320),
      lastTestedAt: hoursAgo(12),
    },
  });

  await prisma.apnsRegistration.create({
    data: {
      id: ids.push.registration,
      clientRegistrationId: "client-reg-acme-0001",
      token: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      tokenHash: "sha256-apns-token-0001",
      topic: "com.acme.app",
      environment: "PRODUCTION",
      pushTypesJson: JSON.stringify(["alert", "background"]),
      displayName: "Acme QA iPhone",
      deviceModel: "iPhone16,1",
      osVersion: "18.5",
      appVersion: "3.4.1",
      appBuild: "3410",
      status: "ACTIVE",
      lastRegisteredAt: daysAgo(2),
      lastSentAt: hoursAgo(12),
    },
  });

  await prisma.pushNotificationBatch.create({
    data: {
      id: ids.push.batch,
      requestId: "push-batch-request-1",
      status: "COMPLETED",
      editorJson: JSON.stringify({ title: "New release available" }),
      payloadJson: JSON.stringify({
        aps: { alert: { title: "New release available" } },
      }),
      headersJson: JSON.stringify({ "apns-topic": "com.acme.app" }),
      targetMode: "REGISTRATIONS",
      recipientCount: 1,
      successCount: 1,
      failureCount: 0,
      createdAt: hoursAgo(12),
      startedAt: hoursAgo(12),
      finishedAt: hoursAgo(12),
      deliveries: {
        create: [
          {
            id: "push-delivery-1",
            registrationId: ids.push.registration,
            tokenHash: "sha256-apns-token-0001",
            topic: "com.acme.app",
            environment: "PRODUCTION",
            status: "DELIVERED",
            apnsId: "apns-id-0001",
            responseCode: 200,
            attempts: 1,
            durationMs: 88,
            createdAt: hoursAgo(12),
            finishedAt: hoursAgo(12),
          },
        ],
      },
    },
  });
}
