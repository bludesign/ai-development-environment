import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

export async function seedNotifications(prisma: PrismaClient): Promise<void> {
  await prisma.appNotification.createMany({
    data: [
      {
        id: ids.notifications.buildFailed,
        dedupeKey: "build-failed-ios-test-1",
        typeKey: "build.failed",
        title: "Build failed",
        body: "TEST build for acme/ios-app failed with 3 test failures.",
        href: `/builds/${ids.builds.test}`,
        resourceKind: "BUILD",
        resourceId: ids.builds.test,
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
        sidebarRequested: true,
        browserRequested: false,
        webPushRequested: false,
        createdAt: daysAgo(4),
      },
      {
        id: "notification-command-complete",
        dedupeKey: "command-complete-3001",
        typeKey: "command.succeeded",
        title: "Command succeeded",
        body: "“Run Tests” completed successfully on Studio Mac.",
        href: `/commands/runs/${ids.commandRuns.latest}`,
        resourceKind: "COMMAND_RUN",
        resourceId: ids.commandRuns.latest,
        sidebarRequested: false,
        browserRequested: false,
        webPushRequested: false,
        sidebarDismissedAt: minutesAgo(9),
        createdAt: minutesAgo(11),
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
