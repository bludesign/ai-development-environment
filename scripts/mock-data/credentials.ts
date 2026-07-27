import type { PrismaClient } from "../../src/generated/prisma/client";

import { daysAgo } from "./time";

/**
 * Credential metadata rows. `isConfigured()` matches on the exact descriptor id + kind and the
 * active backend's storage type (which defaults to lowercase "database"), so these rows use the
 * real descriptor ids from src/services/credentials/types.ts with a plaintext payload.
 *
 * GitHub and Jira API tokens are intentionally omitted: configuring them flips their pages out
 * of the clean "connect" onboarding state into live-fetch errors (no real GitHub/Jira here).
 * The credentials seeded below only surface "configured" badges and never trigger a live call
 * on page load.
 */
export async function seedCredentials(prisma: PrismaClient): Promise<void> {
  const payload = Buffer.from("mock-credential-value", "utf8");
  await prisma.credential.createMany({
    data: [
      {
        id: "push-notifications/default/token-private-key",
        kind: "apns-token-private-key",
        ownerId: "default",
        storageType: "database",
        payload,
        encrypted: false,
        keyFingerprint: "SHA256:acmeApnsKey1122334455",
        createdAt: daysAgo(40),
      },
      {
        id: "notifications/default/web-push-vapid-private-key",
        kind: "web-push-vapid-private-key",
        ownerId: "default",
        storageType: "database",
        payload,
        encrypted: false,
        keyFingerprint: "SHA256:acmeWebPushKey5566778899",
        createdAt: daysAgo(30),
      },
      {
        id: "ios-devices/default/app-store-connect-private-key",
        kind: "app-store-connect-private-key",
        ownerId: "default",
        storageType: "database",
        payload,
        encrypted: false,
        keyFingerprint: "SHA256:acmeConnectKey1234567890",
        createdAt: daysAgo(12),
      },
      {
        id: "ios-devices/default/profile-signer-private-key",
        kind: "ios-profile-signer-private-key",
        ownerId: "default",
        storageType: "database",
        payload,
        encrypted: false,
        keyFingerprint: "SHA256:acmeSignerKey0987654321",
        createdAt: daysAgo(20),
      },
    ],
  });
}
