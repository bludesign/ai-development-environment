import type { Prisma } from "@/generated/prisma/client";

export const CREDENTIAL_STORAGE_TYPES = [
  "database",
  "vault",
  "keychain",
] as const;

export type CredentialStorageType = (typeof CREDENTIAL_STORAGE_TYPES)[number];

export const CREDENTIAL_KINDS = {
  jiraConnectionSettings: "jira-connection-settings",
  jiraApiToken: "jira-api-token",
  jiraWebhookSettings: "jira-webhook-settings",
  jiraWebhookSecret: "jira-webhook-secret",
  githubPersonalAccessToken: "github-personal-access-token",
  githubAppSettings: "github-app-settings",
  githubAppPrivateKey: "github-app-private-key",
  githubAppWebhookSecret: "github-app-webhook-secret",
  cacheServerSettings: "cache-server-settings",
  cacheServerApiKey: "cache-server-api-key",
  externalMcpServerHeaders: "external-mcp-server-headers",
  iosProfileSignerPrivateKey: "ios-profile-signer-private-key",
  appStoreConnectSettings: "app-store-connect-settings",
  appStoreConnectPrivateKey: "app-store-connect-private-key",
  apnsTokenSettings: "apns-token-settings",
  apnsTokenPrivateKey: "apns-token-private-key",
  apnsCertificateCatalog: "apns-certificate-catalog",
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
  jiraConnectionSettings: {
    id: "jira/default/connection-settings",
    kind: CREDENTIAL_KINDS.jiraConnectionSettings,
    ownerId: "default",
  },
  jiraApiToken: {
    id: "jira/default/api-token",
    kind: CREDENTIAL_KINDS.jiraApiToken,
    ownerId: "default",
  },
  jiraWebhookSecret: {
    id: "jira/default/webhook-secret",
    kind: CREDENTIAL_KINDS.jiraWebhookSecret,
    ownerId: "default",
  },
  jiraWebhookSettings: {
    id: "jira/default/webhook-settings",
    kind: CREDENTIAL_KINDS.jiraWebhookSettings,
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
  githubAppSettings: {
    id: "github-app/default/settings",
    kind: CREDENTIAL_KINDS.githubAppSettings,
    ownerId: "default",
  },
  githubAppWebhookSecret: {
    id: "github-app/default/webhook-secret",
    kind: CREDENTIAL_KINDS.githubAppWebhookSecret,
    ownerId: "default",
  },
  cacheServerSettings: {
    id: "cache-server/default/settings",
    kind: CREDENTIAL_KINDS.cacheServerSettings,
    ownerId: "default",
  },
  cacheServerApiKey: {
    id: "cache-server/default/api-key",
    kind: CREDENTIAL_KINDS.cacheServerApiKey,
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
  appStoreConnectSettings: {
    id: "ios-devices/default/app-store-connect-settings",
    kind: CREDENTIAL_KINDS.appStoreConnectSettings,
    ownerId: "default",
  },
  apnsTokenPrivateKey: {
    id: "push-notifications/default/token-private-key",
    kind: CREDENTIAL_KINDS.apnsTokenPrivateKey,
    ownerId: "default",
  },
  apnsTokenSettings: {
    id: "push-notifications/default/token-settings",
    kind: CREDENTIAL_KINDS.apnsTokenSettings,
    ownerId: "default",
  },
  apnsCertificateCatalog: {
    id: "push-notifications/default/certificate-catalog",
    kind: CREDENTIAL_KINDS.apnsCertificateCatalog,
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
  | "APP_SECRET_INVALID"
  | "CREDENTIAL_KEY_MISMATCH"
  | "CREDENTIAL_DATA_INVALID"
  | "CREDENTIAL_STORAGE_TYPE_INVALID"
  | "CREDENTIAL_STORE_UNAVAILABLE"
  | "CREDENTIAL_STORE_READ_ONLY"
  | "VAULT_CONFIGURATION_INVALID"
  | "VAULT_INSECURE_HTTP"
  | "VAULT_TLS_VERIFICATION_DISABLED"
  | "VAULT_READ_ONLY_IGNORED"
  | "VAULT_ADOPTION_FAILED"
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
  // Only a Vault-backed store can report true.
  readOnly: boolean;
  adoptedCount: number;
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
    case CREDENTIAL_KINDS.jiraConnectionSettings:
    case CREDENTIAL_KINDS.jiraApiToken:
    case CREDENTIAL_KINDS.jiraWebhookSettings:
    case CREDENTIAL_KINDS.jiraWebhookSecret:
      return "Jira";
    case CREDENTIAL_KINDS.githubPersonalAccessToken:
    case CREDENTIAL_KINDS.githubAppSettings:
    case CREDENTIAL_KINDS.githubAppPrivateKey:
    case CREDENTIAL_KINDS.githubAppWebhookSecret:
      return "GitHub";
    case CREDENTIAL_KINDS.cacheServerSettings:
    case CREDENTIAL_KINDS.cacheServerApiKey:
      return "Actions cache";
    case CREDENTIAL_KINDS.externalMcpServerHeaders:
      return "External MCP server";
    case CREDENTIAL_KINDS.iosProfileSignerPrivateKey:
    case CREDENTIAL_KINDS.appStoreConnectSettings:
    case CREDENTIAL_KINDS.appStoreConnectPrivateKey:
      return "iOS devices";
    case CREDENTIAL_KINDS.apnsTokenSettings:
    case CREDENTIAL_KINDS.apnsTokenPrivateKey:
    case CREDENTIAL_KINDS.apnsCertificateCatalog:
    case CREDENTIAL_KINDS.apnsCertificateBundle:
      return "Push notifications";
    case CREDENTIAL_KINDS.webPushVapidPrivateKey:
      return "Notifications";
    default:
      return "Unknown";
  }
}
