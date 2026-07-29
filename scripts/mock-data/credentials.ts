import type { PrismaClient } from "../../src/generated/prisma/client";

import {
  encryptCredential,
  parseCredentialEncryptionKey,
} from "../../src/services/credentials/crypto";
import type { CredentialKind } from "../../src/services/credentials/types";

import { MOCK_CREDENTIAL_ENCRYPTION_KEY } from "./encryption-key";
import { daysAgo } from "./time";

/**
 * Credential rows. `isConfigured()` matches on the exact descriptor id + kind and the active
 * backend's storage type (lowercase "database"), so these use the real descriptor ids from
 * src/services/credentials/types.ts.
 *
 * Rows are written already encrypted under CREDENTIAL_ENCRYPTION_KEY. Seeding them as
 * plaintext instead makes the database driver run a migrate-and-`VACUUM` pass on the first
 * request that touches credentials, which under the parallel capture run fails with
 * "database table is locked" and takes every credential-backed page down with it.
 *
 * The GitHub and Jira tokens take their pages out of the "connect" onboarding state so they
 * render real content. Those pages then issue live API calls, which the screenshot run points
 * at the local stub server (scripts/mock-api-server.ts) — nothing reaches github.com or
 * atlassian.net. The values are inert strings shaped like real tokens.
 */

type Seed = {
  id: string;
  kind: CredentialKind;
  value: string;
  createdAt: Date;
};

/** Prisma's Bytes columns want a plain ArrayBuffer-backed view, not a Node Buffer. */
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(value);

const SEEDS: Seed[] = [
  {
    id: "github/default/personal-access-token",
    kind: "github-personal-access-token",
    value: "ghp_acme0MockScreenshotToken0000000000000",
    createdAt: daysAgo(60),
  },
  {
    // GitHubService.webhooksEnabled() gates the Webhooks page on this secret in addition to
    // gitHubAppSettings.webhookUrl; without it the page redirects home and the screenshot
    // captures the Action Center instead.
    id: "github-app/default/webhook-secret",
    kind: "github-app-webhook-secret",
    value: "acme-mock-github-app-webhook-secret",
    createdAt: daysAgo(60),
  },
  {
    id: "jira/default/api-token",
    kind: "jira-api-token",
    value: "ATATT3xFfGF0AcmeMockScreenshotJiraToken00",
    createdAt: daysAgo(55),
  },
  {
    id: "jira/default/webhook-secret",
    kind: "jira-webhook-secret",
    value: "acme-mock-screenshot-jira-webhook-secret",
    createdAt: daysAgo(30),
  },
  {
    id: "cache-server/default/api-key",
    kind: "cache-server-api-key",
    value: "acme-cache-server-mock-api-key",
    createdAt: daysAgo(45),
  },
  {
    id: "push-notifications/default/token-private-key",
    kind: "apns-token-private-key",
    value: "mock-apns-token-private-key",
    createdAt: daysAgo(40),
  },
  {
    id: "notifications/default/web-push-vapid-private-key",
    kind: "web-push-vapid-private-key",
    value: "mock-web-push-vapid-private-key",
    createdAt: daysAgo(30),
  },
  {
    id: "ios-devices/default/app-store-connect-private-key",
    kind: "app-store-connect-private-key",
    value: "mock-app-store-connect-private-key",
    createdAt: daysAgo(12),
  },
  {
    id: "ios-devices/default/profile-signer-private-key",
    kind: "ios-profile-signer-private-key",
    value: "mock-ios-profile-signer-private-key",
    createdAt: daysAgo(20),
  },
];

export async function seedCredentials(prisma: PrismaClient): Promise<void> {
  const key = parseCredentialEncryptionKey(MOCK_CREDENTIAL_ENCRYPTION_KEY);
  await prisma.credential.createMany({
    data: SEEDS.map((seed) => {
      const encrypted = encryptCredential(
        { id: seed.id, kind: seed.kind },
        Buffer.from(seed.value, "utf8"),
        key,
      );
      return {
        id: seed.id,
        kind: seed.kind,
        ownerId: "default",
        storageType: "database",
        payload: bytes(encrypted.payload),
        encrypted: true,
        encryptionVersion: encrypted.encryptionVersion,
        nonce: bytes(encrypted.nonce),
        authTag: bytes(encrypted.authTag),
        keyFingerprint: encrypted.keyFingerprint,
        createdAt: seed.createdAt,
        // Prisma otherwise fills @updatedAt from the real seed-process clock.
        updatedAt: seed.createdAt,
      };
    }),
  });
}
