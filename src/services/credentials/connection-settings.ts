import { CredentialStoreOperationError } from "./driver";
import type { CredentialDescriptor } from "./types";

export type JiraConnectionSettings = {
  siteUrl: string;
  email: string;
};

export type JiraWebhookConnectionSettings = {
  url: string;
  jql: string | null;
};

export type GitHubAppConnectionSettings = {
  appId: string;
  installationId: string;
  webhookUrl: string | null;
};

export type GitLabConnectionSettings = {
  baseUrl: string;
};

export type CacheServerConnectionSettings = {
  baseUrl: string;
  headers: Array<{ name: string; value: string }>;
};

export type AppStoreConnectConnectionSettings = {
  issuerId: string;
  keyId: string;
};

export type ApnsTokenConnectionSettings = {
  teamId: string;
  keyId: string;
};

export type ApnsCertificateCatalogEntry = {
  id: string;
  name: string;
  topic: string;
  environment: "SANDBOX" | "PRODUCTION";
};

export type ApnsCertificateCatalog = ApnsCertificateCatalogEntry[];

type JsonCredentialReader = {
  getJson<T>(descriptor: CredentialDescriptor): Promise<T | null>;
  getJsonWithMetadata?<T>(descriptor: CredentialDescriptor): Promise<{
    value: T;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  getValidatedJsonWithMetadata?<T>(
    descriptor: CredentialDescriptor,
    validate: (value: unknown) => T,
  ): Promise<{ value: T; createdAt: Date; updatedAt: Date } | null>;
};

export async function readConnectionSettings<T>(
  credentials: JsonCredentialReader,
  descriptor: CredentialDescriptor,
  validate: (value: unknown) => T,
): Promise<{ value: T; createdAt: Date; updatedAt: Date } | null> {
  if (typeof credentials.getValidatedJsonWithMetadata === "function") {
    return credentials.getValidatedJsonWithMetadata(descriptor, validate);
  }
  if (typeof credentials.getJsonWithMetadata === "function") {
    const stored = await credentials.getJsonWithMetadata<unknown>(descriptor);
    return stored ? { ...stored, value: validate(stored.value) } : null;
  }
  // Lightweight service mocks written before metadata reads existed can still exercise
  // feature behavior. Production CredentialService instances always take the branch above.
  const value = await credentials.getJson<unknown>(descriptor);
  return value
    ? { value: validate(value), createdAt: new Date(0), updatedAt: new Date(0) }
    : null;
}

function invalid(label: string): never {
  throw new CredentialStoreOperationError(
    `The stored ${label} credential is invalid`,
    "CREDENTIAL_DATA_INVALID",
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(label);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) return invalid(label);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

export function jiraConnectionSettings(value: unknown): JiraConnectionSettings {
  const source = record(value, "Jira connection settings");
  return {
    siteUrl: string(source.siteUrl, "Jira connection settings"),
    email: string(source.email, "Jira connection settings"),
  };
}

export function jiraWebhookConnectionSettings(
  value: unknown,
): JiraWebhookConnectionSettings {
  const source = record(value, "Jira webhook settings");
  return {
    url: string(source.url, "Jira webhook settings"),
    jql: nullableString(source.jql, "Jira webhook settings"),
  };
}

export function githubAppConnectionSettings(
  value: unknown,
): GitHubAppConnectionSettings {
  const source = record(value, "GitHub App settings");
  return {
    appId: string(source.appId, "GitHub App settings"),
    installationId: string(source.installationId, "GitHub App settings"),
    webhookUrl: nullableString(source.webhookUrl, "GitHub App settings"),
  };
}

export function gitlabConnectionSettings(
  value: unknown,
): GitLabConnectionSettings {
  const source = record(value, "GitLab connection settings");
  return {
    baseUrl: string(source.baseUrl, "GitLab connection settings"),
  };
}

export function cacheServerConnectionSettings(
  value: unknown,
): CacheServerConnectionSettings {
  const source = record(value, "Actions cache settings");
  if (!Array.isArray(source.headers)) return invalid("Actions cache settings");
  return {
    baseUrl: string(source.baseUrl, "Actions cache settings"),
    headers: source.headers.map((entry) => {
      const header = record(entry, "Actions cache settings");
      return {
        name: string(header.name, "Actions cache settings"),
        value: string(header.value, "Actions cache settings"),
      };
    }),
  };
}

export function appStoreConnectConnectionSettings(
  value: unknown,
): AppStoreConnectConnectionSettings {
  const source = record(value, "App Store Connect settings");
  return {
    issuerId: string(source.issuerId, "App Store Connect settings"),
    keyId: string(source.keyId, "App Store Connect settings"),
  };
}

export function apnsTokenConnectionSettings(
  value: unknown,
): ApnsTokenConnectionSettings {
  const source = record(value, "APNs token settings");
  return {
    teamId: string(source.teamId, "APNs token settings"),
    keyId: string(source.keyId, "APNs token settings"),
  };
}

export function apnsCertificateCatalog(value: unknown): ApnsCertificateCatalog {
  if (!Array.isArray(value)) return invalid("APNs certificate catalog");
  const ids = new Set<string>();
  return value.map((entry) => {
    const source = record(entry, "APNs certificate catalog");
    const id = string(source.id, "APNs certificate catalog");
    if (ids.has(id)) return invalid("APNs certificate catalog");
    ids.add(id);
    const environment = string(source.environment, "APNs certificate catalog");
    if (environment !== "SANDBOX" && environment !== "PRODUCTION") {
      return invalid("APNs certificate catalog");
    }
    return {
      id,
      name: string(source.name, "APNs certificate catalog"),
      topic: string(source.topic, "APNs certificate catalog"),
      environment,
    };
  });
}
