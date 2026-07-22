import {
  credentialKeyFingerprint,
  parseCredentialEncryptionKey,
} from "./crypto";
import type {
  CredentialStorageType,
  CredentialStoreDetail,
  CredentialStoreIssue,
} from "./types";

const DEFAULT_VAULT_MOUNT = "secret";
const DEFAULT_VAULT_PREFIX = "ai-development-environment/credentials";
const TRANSPORT_MANAGED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "expect",
  "host",
  "transfer-encoding",
  "upgrade",
  "x-vault-request",
]);

export type DatabaseCredentialStoreConfig = {
  storageType: "database";
  encryptionKey: Buffer | null;
  keyFingerprint: string | null;
};

export type VaultCredentialStoreConfig = {
  storageType: "vault";
  address: URL;
  token: string | null;
  namespace: string | null;
  mount: string;
  pathPrefix: string;
  headers: Record<string, string>;
  caCertPath: string | null;
  tlsServerName: string | null;
  skipVerify: boolean;
};

export type KeychainCredentialStoreConfig = {
  storageType: "keychain";
  platform: NodeJS.Platform;
  service: "com.bludesign.ai-development-environment.credentials";
};

export type CredentialStoreConfig =
  | DatabaseCredentialStoreConfig
  | VaultCredentialStoreConfig
  | KeychainCredentialStoreConfig;

export type CredentialEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type CredentialStoreConfigResult = {
  requestedStorageType: string;
  storageType: CredentialStorageType | "unknown";
  config: CredentialStoreConfig | null;
  warnings: CredentialStoreIssue[];
  errors: CredentialStoreIssue[];
  details: CredentialStoreDetail[];
};

function issue(
  code: CredentialStoreIssue["code"],
  message: string,
): CredentialStoreIssue {
  return { code, message };
}

function parseBoolean(value: string | undefined, name: string): boolean {
  if (!value || value === "0" || value.toLowerCase() === "false") return false;
  if (value === "1" || value.toLowerCase() === "true") return true;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function cleanVaultPath(value: string, name: string): string {
  const cleaned = value.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/");
  if (
    !cleaned ||
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  ) {
    throw new Error(`${name} must contain non-empty Vault path segments`);
  }
  return cleaned;
}

function parseVaultHeaders(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CREDENTIAL_VAULT_HEADERS must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CREDENTIAL_VAULT_HEADERS must be a JSON object");
  }
  const headers: Record<string, string> = {};
  for (const [rawName, headerValue] of Object.entries(parsed)) {
    const name = rawName.trim();
    if (!name || typeof headerValue !== "string") {
      throw new Error(
        "CREDENTIAL_VAULT_HEADERS must contain only string header values",
      );
    }
    try {
      new Headers({ [name]: headerValue });
    } catch {
      throw new Error(
        `CREDENTIAL_VAULT_HEADERS contains invalid header ${name}`,
      );
    }
    if (TRANSPORT_MANAGED_HEADERS.has(name.toLowerCase())) {
      throw new Error(
        `CREDENTIAL_VAULT_HEADERS cannot override the managed ${name} header`,
      );
    }
    const existing = Object.keys(headers).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      throw new Error(`CREDENTIAL_VAULT_HEADERS repeats the ${name} header`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
}

export function readCredentialStoreConfig(
  env: CredentialEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): CredentialStoreConfigResult {
  const requestedStorageType =
    env.CREDENTIAL_STORAGE_TYPE?.trim().toLowerCase() || "database";
  if (
    requestedStorageType !== "database" &&
    requestedStorageType !== "vault" &&
    requestedStorageType !== "keychain"
  ) {
    return {
      requestedStorageType,
      storageType: "unknown",
      config: null,
      warnings: [],
      errors: [
        issue(
          "CREDENTIAL_STORAGE_TYPE_INVALID",
          "CREDENTIAL_STORAGE_TYPE must be database, vault, or keychain",
        ),
      ],
      details: [{ label: "Configured value", value: requestedStorageType }],
    };
  }

  if (requestedStorageType === "database") {
    const keyValue = env.CREDENTIAL_ENCRYPTION_KEY;
    if (!keyValue) {
      return {
        requestedStorageType,
        storageType: "database",
        config: {
          storageType: "database",
          encryptionKey: null,
          keyFingerprint: null,
        },
        warnings: [
          issue(
            "DATABASE_UNENCRYPTED",
            "Database credentials are stored as plaintext until CREDENTIAL_ENCRYPTION_KEY is configured",
          ),
        ],
        errors: [],
        details: [
          { label: "Location", value: "Application database" },
          { label: "Encryption key", value: "Not configured" },
        ],
      };
    }
    try {
      const encryptionKey = parseCredentialEncryptionKey(keyValue);
      return {
        requestedStorageType,
        storageType: "database",
        config: {
          storageType: "database",
          encryptionKey,
          keyFingerprint: credentialKeyFingerprint(encryptionKey),
        },
        warnings: [],
        errors: [],
        details: [
          { label: "Location", value: "Application database" },
          { label: "Encryption key", value: "Configured" },
        ],
      };
    } catch (error) {
      return {
        requestedStorageType,
        storageType: "database",
        config: null,
        warnings: [],
        errors: [
          issue(
            "CREDENTIAL_ENCRYPTION_KEY_INVALID",
            error instanceof Error
              ? error.message
              : "The encryption key is invalid",
          ),
        ],
        details: [
          { label: "Location", value: "Application database" },
          { label: "Encryption key", value: "Invalid" },
        ],
      };
    }
  }

  if (requestedStorageType === "keychain") {
    const supported = platform === "darwin";
    return {
      requestedStorageType,
      storageType: "keychain",
      config: {
        storageType: "keychain",
        platform,
        service: "com.bludesign.ai-development-environment.credentials",
      },
      warnings: [],
      errors: supported
        ? []
        : [
            issue(
              "KEYCHAIN_UNSUPPORTED_PLATFORM",
              "macOS Keychain storage is only available when the Next.js host runs on macOS",
            ),
          ],
      details: [
        {
          label: "Service",
          value: "com.bludesign.ai-development-environment.credentials",
        },
        { label: "Host platform", value: platform },
      ],
    };
  }

  const errors: CredentialStoreIssue[] = [];
  const warnings: CredentialStoreIssue[] = [];
  let address: URL;
  let headers: Record<string, string> = {};
  let mount = DEFAULT_VAULT_MOUNT;
  let pathPrefix = DEFAULT_VAULT_PREFIX;
  let skipVerify = false;
  try {
    if (!env.VAULT_ADDR?.trim()) throw new Error("VAULT_ADDR is required");
    address = new URL(env.VAULT_ADDR);
    if (address.protocol !== "https:" && address.protocol !== "http:") {
      throw new Error("VAULT_ADDR must use http or https");
    }
    if (
      address.username ||
      address.password ||
      address.search ||
      address.hash
    ) {
      throw new Error(
        "VAULT_ADDR cannot contain credentials, query parameters, or a fragment",
      );
    }
    address.pathname = address.pathname.replace(/\/+$/, "");
    headers = parseVaultHeaders(env.CREDENTIAL_VAULT_HEADERS);
    mount = cleanVaultPath(
      env.CREDENTIAL_VAULT_MOUNT || DEFAULT_VAULT_MOUNT,
      "CREDENTIAL_VAULT_MOUNT",
    );
    pathPrefix = cleanVaultPath(
      env.CREDENTIAL_VAULT_PATH_PREFIX || DEFAULT_VAULT_PREFIX,
      "CREDENTIAL_VAULT_PATH_PREFIX",
    );
    skipVerify = parseBoolean(env.VAULT_SKIP_VERIFY, "VAULT_SKIP_VERIFY");
    if (env.VAULT_TOKEN && hasHeader(headers, "x-vault-token")) {
      throw new Error(
        "VAULT_TOKEN conflicts with X-Vault-Token in CREDENTIAL_VAULT_HEADERS",
      );
    }
    if (env.VAULT_NAMESPACE && hasHeader(headers, "x-vault-namespace")) {
      throw new Error(
        "VAULT_NAMESPACE conflicts with X-Vault-Namespace in CREDENTIAL_VAULT_HEADERS",
      );
    }
  } catch (error) {
    errors.push(
      issue(
        "VAULT_CONFIGURATION_INVALID",
        error instanceof Error
          ? error.message
          : "Vault configuration is invalid",
      ),
    );
    address = new URL("https://invalid.local");
  }
  if (address.protocol === "http:") {
    warnings.push(
      issue(
        "VAULT_INSECURE_HTTP",
        "VAULT_ADDR uses plaintext HTTP; Vault credentials and authentication headers are not protected in transit",
      ),
    );
  }
  if (skipVerify) {
    warnings.push(
      issue(
        "VAULT_TLS_VERIFICATION_DISABLED",
        "VAULT_SKIP_VERIFY disables certificate verification for Vault connections",
      ),
    );
  }
  const headerNames = Object.keys(headers).sort((a, b) => a.localeCompare(b));
  const details: CredentialStoreDetail[] = [
    { label: "Address", value: errors.length ? "Invalid" : address.toString() },
    { label: "KV v2 mount", value: mount },
    { label: "Path prefix", value: pathPrefix },
    {
      label: "Namespace",
      value: env.VAULT_NAMESPACE ? "Configured" : "Not configured",
    },
    {
      label: "Authentication token",
      value:
        env.VAULT_TOKEN || hasHeader(headers, "x-vault-token")
          ? "Configured"
          : "Not configured",
    },
    {
      label: "Additional headers",
      value: headerNames.length ? headerNames.join(", ") : "None",
    },
    {
      label: "Custom CA",
      value: env.VAULT_CACERT ? "Configured" : "Not configured",
    },
    {
      label: "TLS server name",
      value: env.VAULT_TLS_SERVER_NAME ? "Configured" : "Not configured",
    },
  ];
  return {
    requestedStorageType,
    storageType: "vault",
    config:
      errors.length === 0
        ? {
            storageType: "vault",
            address,
            token: env.VAULT_TOKEN || null,
            namespace: env.VAULT_NAMESPACE || null,
            mount,
            pathPrefix,
            headers,
            caCertPath: env.VAULT_CACERT || null,
            tlsServerName: env.VAULT_TLS_SERVER_NAME || null,
            skipVerify,
          }
        : null,
    warnings,
    errors,
    details,
  };
}
