import type { PrismaClient } from "../../src/generated/prisma/client";

import { daysAgo, hoursAgo } from "./time";

/**
 * Singleton configuration rows. Seeding these makes integration-dependent pages
 * (GitHub, Jira, push notifications, costs, cache server) render as "configured"
 * instead of their empty setup states.
 */
export async function seedSettings(prisma: PrismaClient): Promise<void> {
  await prisma.gitHubSettings.deleteMany({});
  await prisma.gitHubSettings.create({
    data: {
      id: "default",
      actionsNotificationPollIntervalSeconds: 60,
      cacheTtlSeconds: 300,
    },
  });

  await prisma.gitHubAppSettings.deleteMany({});
  await prisma.gitHubAppSettings.create({
    data: {
      id: "default",
      appId: "845213",
      installationId: "61240983",
      keyFingerprint: "SHA256:aXm4Qe1acme9development2environment8bot0key",
      appSlug: "acme-dev-bot",
      appOwnerLogin: "acme",
      appOwnerType: "Organization",
      accountLogin: "acme",
      repositorySelection: "all",
      actionsPermission: "write",
      checksPermission: "read",
      commitStatusesPermission: "read",
      webhookEventsJson: JSON.stringify([
        "check_run",
        "check_suite",
        "workflow_run",
        "workflow_job",
        "pull_request",
      ]),
      enhancedPipelineWebhooksEnabled: true,
      verifiedAt: hoursAgo(3),
      webhookUrl: "https://dev.acme.example.com/api/github/webhook",
      webhookConfiguredAt: hoursAgo(3),
    },
  });

  await prisma.jiraSettings.deleteMany({});
  await prisma.jiraSettings.create({
    data: {
      id: "default",
      siteUrl: "https://acme.atlassian.net",
      email: "dev-bot@acme.example.com",
      cacheTtlSeconds: 300,
    },
  });

  await prisma.cacheServerSettings.deleteMany({});
  await prisma.cacheServerSettings.create({
    data: {
      id: "default",
      baseUrl: "https://cache.acme.example.com",
      headerNamesJson: JSON.stringify(["x-acme-cache", "x-acme-region"]),
    },
  });

  await prisma.telemetrySettings.deleteMany({});
  await prisma.telemetrySettings.create({
    data: {
      id: "default",
      consoleCollectionEnabled: true,
      analyticsCollectionEnabled: true,
    },
  });

  await prisma.skillSettings.deleteMany({});
  await prisma.skillSettings.create({
    data: { id: "default", autoSyncProjectGroups: true },
  });

  await prisma.diskSpaceSettings.deleteMany({});
  await prisma.diskSpaceSettings.create({
    data: { id: "default", normalThresholdGiB: 40, pressureThresholdGiB: 10 },
  });

  await prisma.worktreeSettings.deleteMany({});
  await prisma.worktreeSettings.create({
    data: { id: "default", editorVariant: "CODE" },
  });

  await prisma.codebaseSettings.deleteMany({});
  await prisma.codebaseSettings.create({ data: { id: "default" } });

  await prisma.iosDeviceSettings.deleteMany({});
  await prisma.iosDeviceSettings.create({
    data: {
      id: "default",
      organizationName: "Acme Inc.",
      profileIdentifier: "com.acme.device-enrollment",
      appStoreConnectIssuerId: "69a6de70-acme-47e3-e053-5b8c7c11a4d1",
      appStoreConnectKeyId: "ACME2K5J9L",
      appStoreConnectPrivateKeyFingerprint: "SHA256:acmeConnectKey1234567890",
      appStoreConnectVerifiedAt: daysAgo(12),
      appStoreConnectLastTestedAt: hoursAgo(20),
    },
  });

  await prisma.pushNotificationSettings.deleteMany({});
  await prisma.pushNotificationSettings.create({
    data: {
      id: "default",
      tokenTeamId: "ACME9T4R2K",
      tokenKeyId: "ACME7K1J9P",
      tokenPrivateKeyFingerprint: "SHA256:acmePushKey0987654321",
      tokenConfiguredAt: daysAgo(9),
      tokenLastUsedAt: hoursAgo(5),
    },
  });

  await prisma.webPushSettings.deleteMany({});
  await prisma.webPushSettings.create({
    data: {
      id: "default",
      vapidPublicKey:
        "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-Sk_acme_development_environment_demo_vapid_public_key_00",
      vapidGeneratedAt: daysAgo(30),
    },
  });

  await prisma.modelCostSettings.deleteMany({});
  await prisma.modelCostSettings.create({
    data: {
      id: "default",
      catalogUrl: "https://models.acme.example.com/pricing.json",
      sourceUrl: "https://models.acme.example.com/pricing.json",
      fetchedAt: hoursAgo(6),
      entryCount: 5,
    },
  });

  await prisma.modelCostEntry.deleteMany({});
  await prisma.modelCostEntry.createMany({
    data: [
      {
        model: "claude-sonnet-4.5",
        provider: "anthropic",
        mode: "chat",
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        cacheReadCostPerToken: 0.0000003,
        cacheWriteCostPerToken: 0.00000375,
        maxInputTokens: 200000,
        maxOutputTokens: 64000,
      },
      {
        model: "claude-opus-4.1",
        provider: "anthropic",
        mode: "chat",
        inputCostPerToken: 0.000015,
        outputCostPerToken: 0.000075,
        cacheReadCostPerToken: 0.0000015,
        cacheWriteCostPerToken: 0.00001875,
        maxInputTokens: 200000,
        maxOutputTokens: 32000,
      },
      {
        model: "gpt-5-codex",
        provider: "openai",
        mode: "chat",
        inputCostPerToken: 0.00000125,
        outputCostPerToken: 0.00001,
        cacheReadCostPerToken: 0.000000125,
        maxInputTokens: 400000,
        maxOutputTokens: 128000,
      },
      {
        model: "gpt-5-mini",
        provider: "openai",
        mode: "chat",
        inputCostPerToken: 0.00000025,
        outputCostPerToken: 0.000002,
        cacheReadCostPerToken: 0.000000025,
        maxInputTokens: 400000,
        maxOutputTokens: 128000,
      },
      {
        model: "o4-mini",
        provider: "openai",
        mode: "chat",
        inputCostPerToken: 0.0000011,
        outputCostPerToken: 0.0000044,
        cacheReadCostPerToken: 0.000000275,
        maxInputTokens: 200000,
        maxOutputTokens: 100000,
      },
    ],
  });
}
