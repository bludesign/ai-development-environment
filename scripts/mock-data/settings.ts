import type { PrismaClient } from "../../src/generated/prisma/client";

import { daysAgo, hoursAgo } from "./time";

/** Prices are per token; the Costs page multiplies them up to a per-million-token figure. */
const MODEL_COST_ENTRIES = [
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
    model: "claude-haiku-4.5",
    provider: "anthropic",
    mode: "chat",
    inputCostPerToken: 0.000001,
    outputCostPerToken: 0.000005,
    cacheReadCostPerToken: 0.0000001,
    cacheWriteCostPerToken: 0.00000125,
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
  },
  {
    model: "claude-sonnet-4",
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
    model: "claude-3-5-haiku",
    provider: "anthropic",
    mode: "chat",
    inputCostPerToken: 0.0000008,
    outputCostPerToken: 0.000004,
    cacheReadCostPerToken: 0.00000008,
    cacheWriteCostPerToken: 0.000001,
    maxInputTokens: 200000,
    maxOutputTokens: 8192,
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
    model: "gpt-5-nano",
    provider: "openai",
    mode: "chat",
    inputCostPerToken: 0.00000005,
    outputCostPerToken: 0.0000004,
    cacheReadCostPerToken: 0.000000005,
    maxInputTokens: 400000,
    maxOutputTokens: 128000,
  },
  {
    model: "gpt-4.1",
    provider: "openai",
    mode: "chat",
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000008,
    cacheReadCostPerToken: 0.0000005,
    maxInputTokens: 1047576,
    maxOutputTokens: 32768,
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
  {
    model: "o3",
    provider: "openai",
    mode: "chat",
    inputCostPerToken: 0.000002,
    outputCostPerToken: 0.000008,
    cacheReadCostPerToken: 0.0000005,
    maxInputTokens: 200000,
    maxOutputTokens: 100000,
  },
  {
    model: "gemini-2.5-pro",
    provider: "google",
    mode: "chat",
    inputCostPerToken: 0.00000125,
    outputCostPerToken: 0.00001,
    cacheReadCostPerToken: 0.00000031,
    maxInputTokens: 1048576,
    maxOutputTokens: 65535,
  },
  {
    model: "gemini-2.5-flash",
    provider: "google",
    mode: "chat",
    inputCostPerToken: 0.0000003,
    outputCostPerToken: 0.0000025,
    cacheReadCostPerToken: 0.000000075,
    maxInputTokens: 1048576,
    maxOutputTokens: 65535,
  },
  {
    model: "grok-4",
    provider: "xai",
    mode: "chat",
    inputCostPerToken: 0.000003,
    outputCostPerToken: 0.000015,
    cacheReadCostPerToken: 0.00000075,
    maxInputTokens: 256000,
    maxOutputTokens: 64000,
  },
  {
    model: "deepseek-v3",
    provider: "deepseek",
    mode: "chat",
    inputCostPerToken: 0.00000027,
    outputCostPerToken: 0.0000011,
    cacheReadCostPerToken: 0.00000007,
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
  },
];

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
      webhookConfiguredAt: hoursAgo(3),
    },
  });

  await prisma.jiraSettings.deleteMany({});
  await prisma.jiraSettings.create({
    data: {
      id: "default",
      cacheTtlSeconds: 300,
      webhookEnabled: true,
      webhookConfiguredAt: hoursAgo(3),
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
      appStoreConnectPrivateKeyFingerprint: "SHA256:acmeConnectKey1234567890",
      appStoreConnectVerifiedAt: daysAgo(12),
      appStoreConnectLastTestedAt: hoursAgo(20),
    },
  });

  await prisma.pushNotificationSettings.deleteMany({});
  await prisma.pushNotificationSettings.create({
    data: {
      id: "default",
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

  await prisma.modelCostEntry.deleteMany({});
  await prisma.modelCostEntry.createMany({ data: MODEL_COST_ENTRIES });

  await prisma.modelCostSettings.deleteMany({});
  await prisma.modelCostSettings.create({
    data: {
      id: "default",
      catalogUrl: "https://models.acme.example.com/pricing.json",
      sourceUrl: "https://models.acme.example.com/pricing.json",
      fetchedAt: hoursAgo(6),
      // The "N models" label on the Costs page reads this, not a count of the rows.
      entryCount: MODEL_COST_ENTRIES.length,
    },
  });
}
