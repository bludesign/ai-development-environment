import type { Prisma } from "@/generated/prisma/client";

export const CREDENTIAL_STORAGE_TYPES = [
  "database",
  "vault",
  "keychain",
] as const;

export type CredentialStorageType = (typeof CREDENTIAL_STORAGE_TYPES)[number];

export const CREDENTIAL_KINDS = {
  jiraApiToken: "jira-api-token",
  githubPersonalAccessToken: "github-personal-access-token",
  githubAppPrivateKey: "github-app-private-key",
  cacheServerApiKey: "cache-server-api-key",
  cacheServerHeaders: "cache-server-headers",
  externalMcpServerHeaders: "external-mcp-server-headers",
  iosProfileSignerPrivateKey: "ios-profile-signer-private-key",
  appStoreConnectPrivateKey: "app-store-connect-private-key",
  apnsTokenPrivateKey: "apns-token-private-key",
  apnsCertificateBundle: "apns-certificate-bundle",
  webPushVapidPrivateKey: "web-push-vapid-private-key",
} as const;

export type CredentialKind =
  (typeof CREDENTIAL_KINDS)[keyof typeof CREDENTIAL_KINDS];

export type CredentialDescriptor = {
  id: string;
  kind: CredentialKind;
  ownerId?: string | null;
};

export const CREDENTIALS = {
  jiraApiToken: {
    id: "jira/default/api-token",
    kind: CREDENTIAL_KINDS.jiraApiToken,
    ownerId: "default",
  },
  githubPersonalAccessToken: {
    id: "github/default/personal-access-token",
    kind: CREDENTIAL_KINDS.githubPersonalAccessToken,
    ownerId: "default",
  },
  githubAppPrivateKey: {
    id: "github-app/default/private-key",
    kind: CREDENTIAL_KINDS.githubAppPrivateKey,
    ownerId: "default",
  },
  cacheServerApiKey: {
    id: "cache-server/default/api-key",
    kind: CREDENTIAL_KINDS.cacheServerApiKey,
    ownerId: "default",
  },
  cacheServerHeaders: {
    id: "cache-server/default/headers",
    kind: CREDENTIAL_KINDS.cacheServerHeaders,
    ownerId: "default",
  },
  iosProfileSignerPrivateKey: {
    id: "ios-devices/default/profile-signer-private-key",
    kind: CREDENTIAL_KINDS.iosProfileSignerPrivateKey,
    ownerId: "default",
  },
  appStoreConnectPrivateKey: {
    id: "ios-devices/default/app-store-connect-private-key",
    kind: CREDENTIAL_KINDS.appStoreConnectPrivateKey,
    ownerId: "default",
  },
  apnsTokenPrivateKey: {
    id: "push-notifications/default/token-private-key",
    kind: CREDENTIAL_KINDS.apnsTokenPrivateKey,
    ownerId: "default",
  },
  webPushVapidPrivateKey: {
    id: "notifications/default/web-push-vapid-private-key",
    kind: CREDENTIAL_KINDS.webPushVapidPrivateKey,
    ownerId: "default",
  },
} as const satisfies Record<string, CredentialDescriptor>;

export function externalMcpHeadersCredential(
  serverId: string,
): CredentialDescriptor {
  return {
    id: `external-mcp-server/${serverId}/headers`,
    kind: CREDENTIAL_KINDS.externalMcpServerHeaders,
    ownerId: serverId,
  };
}

export function apnsCertificateCredential(
  certificateId: string,
): CredentialDescriptor {
  return {
    id: `apns-certificate/${certificateId}/bundle`,
    kind: CREDENTIAL_KINDS.apnsCertificateBundle,
    ownerId: certificateId,
  };
}

export type CredentialStoreWarningCode =
  | "DATABASE_UNENCRYPTED"
  | "CREDENTIAL_ENCRYPTION_KEY_INVALID"
  | "CREDENTIAL_ENCRYPTION_KEY_MISSING"
  | "CREDENTIAL_ENCRYPTION_KEY_MISMATCH"
  | "CREDENTIAL_DATA_INVALID"
  | "CREDENTIAL_STORAGE_TYPE_INVALID"
  | "CREDENTIAL_STORE_UNAVAILABLE"
  | "VAULT_CONFIGURATION_INVALID"
  | "VAULT_INSECURE_HTTP"
  | "VAULT_TLS_VERIFICATION_DISABLED"
  | "KEYCHAIN_UNSUPPORTED_PLATFORM"
  | "BACKEND_MISMATCH";

export type CredentialStoreIssue = {
  code: CredentialStoreWarningCode;
  message: string;
};

export type CredentialStoreDetail = {
  label: string;
  value: string;
};

export type CredentialStoreState = "READY" | "WARNING" | "ERROR";

export type CredentialEncryptionState =
  "ENCRYPTED" | "PLAINTEXT" | "EXTERNAL" | "ERROR";

export type CredentialProtection =
  "ENCRYPTED" | "PLAINTEXT" | "VAULT" | "KEYCHAIN";

export type CredentialStoreStatusView = {
  storageType: CredentialStorageType | "unknown";
  state: CredentialStoreState;
  encryptionState: CredentialEncryptionState;
  details: CredentialStoreDetail[];
  itemCount: number;
  mismatchCount: number;
  warnings: CredentialStoreIssue[];
};

export type CredentialMetadataView = {
  id: string;
  kind: string;
  ownerId: string | null;
  ownerFeature: string;
  storageType: CredentialStorageType | "unknown";
  protection: CredentialProtection;
  createdAt: string;
  updatedAt: string;
};

export type CredentialMutation = (
  transaction: Prisma.TransactionClient,
) => Promise<void>;

export type VersionedJsonEnvelope<T> = {
  version: 1;
  value: T;
};

export function encodeJsonCredential<T>(value: T): Buffer {
  return Buffer.from(
    JSON.stringify({ version: 1, value } satisfies VersionedJsonEnvelope<T>),
    "utf8",
  );
}

export function decodeJsonCredential<T>(payload: Uint8Array): T {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new Error("The stored credential envelope is invalid");
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    (envelope as { version?: unknown }).version !== 1 ||
    !("value" in envelope)
  ) {
    throw new Error("The stored credential envelope version is unsupported");
  }
  return (envelope as VersionedJsonEnvelope<T>).value;
}

export function credentialOwnerFeature(kind: string): string {
  switch (kind) {
    case CREDENTIAL_KINDS.jiraApiToken:
      return "Jira";
    case CREDENTIAL_KINDS.githubPersonalAccessToken:
    case CREDENTIAL_KINDS.githubAppPrivateKey:
      return "GitHub";
    case CREDENTIAL_KINDS.cacheServerApiKey:
    case CREDENTIAL_KINDS.cacheServerHeaders:
      return "Actions cache";
    case CREDENTIAL_KINDS.externalMcpServerHeaders:
      return "External MCP server";
    case CREDENTIAL_KINDS.iosProfileSignerPrivateKey:
    case CREDENTIAL_KINDS.appStoreConnectPrivateKey:
      return "iOS devices";
    case CREDENTIAL_KINDS.apnsTokenPrivateKey:
    case CREDENTIAL_KINDS.apnsCertificateBundle:
      return "Push notifications";
    case CREDENTIAL_KINDS.webPushVapidPrivateKey:
      return "Notifications";
    default:
      return "Unknown";
  }
}
