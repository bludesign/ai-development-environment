import { readFile } from "node:fs/promises";

import { Agent, request, type Dispatcher } from "undici";

import type { VaultCredentialStoreConfig } from "./config";
import {
  CredentialStoreOperationError,
  type AdoptableCredential,
  type CredentialDriver,
} from "./driver";
import { CREDENTIAL_KINDS, type CredentialDescriptor } from "./types";
import type { CredentialKind } from "./types";

const VAULT_REQUEST_TIMEOUT_MS = 10_000;
// A supported 20 MiB p12 is base64-encoded by its owning JSON credential and then again
// for Vault storage. Keep enough headroom for both expansions and Vault's response envelope.
const VAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// Credential IDs are three segments deep. Cap the KV metadata walk anyway so a shared or
// hostile mount cannot stall startup, and stop enumerating well before memory is a concern.
const VAULT_MAX_LIST_DEPTH = 4;
const VAULT_MAX_LIST_ENTRIES = 500;

const KNOWN_KINDS = new Set<string>(Object.values(CREDENTIAL_KINDS));

type VaultPayload = {
  value: string;
  kind: CredentialKind;
  ownerId: string | null;
};

export type VaultRequest = typeof request;
export type VaultDispatcherFactory = (
  options: ConstructorParameters<typeof Agent>[0],
) => Dispatcher;

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

// Credential IDs are `{feature}/{ownerId}/{name}`. Entries written before the payload
// carried an explicit ownerId still recover it from that shape.
function ownerIdFromPath(credentialId: string): string | null {
  const segments = credentialId.split("/");
  return segments.length >= 3 ? segments[1] : null;
}

function parseVaultPayload(body: string, credentialId: string): VaultPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Vault returned an invalid credential payload");
  }
  const data = (parsed as { data?: { data?: Record<string, unknown> } } | null)
    ?.data?.data;
  const value = data?.value;
  const kind = data?.kind;
  if (
    !data ||
    typeof value !== "string" ||
    data.version !== 1 ||
    typeof kind !== "string" ||
    !KNOWN_KINDS.has(kind)
  ) {
    throw new Error("Vault returned an invalid credential payload");
  }
  const ownerId = data.ownerId;
  return {
    value,
    kind: kind as CredentialKind,
    ownerId:
      typeof ownerId === "string" && ownerId
        ? ownerId
        : ownerId === null
          ? null
          : ownerIdFromPath(credentialId),
  };
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

export class VaultCredentialDriver implements CredentialDriver {
  readonly storageType = "vault" as const;
  readonly readOnly: boolean;
  private dispatcherPromise: Promise<Dispatcher> | null = null;

  constructor(
    private readonly config: VaultCredentialStoreConfig,
    private readonly requestImplementation: VaultRequest = request,
    private readonly dispatcherFactory: VaultDispatcherFactory = (options) =>
      new Agent(options),
  ) {
    this.readOnly = config.readOnly;
  }

  async initialize(): Promise<void> {
    await this.dispatcher();
  }

  private dispatcher(): Promise<Dispatcher> {
    if (!this.dispatcherPromise) {
      this.dispatcherPromise = (async () => {
        const ca =
          this.config.address.protocol === "https:" && this.config.caCertPath
            ? await readFile(this.config.caCertPath)
            : undefined;
        return this.dispatcherFactory({
          connect: {
            ...(ca ? { ca } : {}),
            ...(this.config.tlsServerName
              ? { servername: this.config.tlsServerName }
              : {}),
            rejectUnauthorized: !this.config.skipVerify,
          },
          connectTimeout: VAULT_REQUEST_TIMEOUT_MS,
          headersTimeout: VAULT_REQUEST_TIMEOUT_MS,
          bodyTimeout: VAULT_REQUEST_TIMEOUT_MS,
          maxResponseSize: VAULT_MAX_RESPONSE_BYTES,
        });
      })();
    }
    return this.dispatcherPromise;
  }

  private endpoint(area: "data" | "metadata", credentialId: string): string {
    return `${this.prefixEndpoint(area)}/${encodePath(credentialId)}`;
  }

  private prefixEndpoint(area: "data" | "metadata"): string {
    const base = this.config.address.toString().replace(/\/+$/, "");
    return `${base}/v1/${encodePath(this.config.mount)}/${area}/${encodePath(
      this.config.pathPrefix,
    )}`;
  }

  private assertWritable(credentialId: string): void {
    if (!this.readOnly) return;
    throw new CredentialStoreOperationError(
      `This install uses a read-only Vault; ${credentialId} cannot be changed here. Update it from a read-write install or clear CREDENTIAL_VAULT_READ_ONLY.`,
      "CREDENTIAL_STORE_READ_ONLY",
    );
  }

  // A token without write capabilities fails the same way whether or not the install
  // declared itself read-only, so both produce the same actionable error.
  private deniedError(credentialId: string): CredentialStoreOperationError {
    return new CredentialStoreOperationError(
      `The Vault token is not permitted to modify ${credentialId}; this install has read-only access.`,
      "CREDENTIAL_STORE_READ_ONLY",
    );
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.config.headers,
      accept: "application/json",
      "x-vault-request": "true",
    };
    if (hasBody) headers["content-type"] = "application/json";
    if (this.config.token) headers["x-vault-token"] = this.config.token;
    if (this.config.namespace) {
      headers["x-vault-namespace"] = this.config.namespace;
    }
    return headers;
  }

  private async call(
    operation: "read" | "list" | "write" | "delete",
    url: string,
    init: { method: "GET" | "POST" | "DELETE"; body?: string },
  ): Promise<{ statusCode: number; body: string }> {
    try {
      const response = await this.requestImplementation(url, {
        method: init.method,
        headers: this.headers(Boolean(init.body)),
        body: init.body,
        dispatcher: await this.dispatcher(),
        signal: AbortSignal.timeout(VAULT_REQUEST_TIMEOUT_MS),
        headersTimeout: VAULT_REQUEST_TIMEOUT_MS,
        bodyTimeout: VAULT_REQUEST_TIMEOUT_MS,
      });
      return {
        statusCode: response.statusCode,
        body: await response.body.text(),
      };
    } catch (error) {
      const code = errorCode(error);
      throw new Error(
        `Vault credential ${operation} failed${code ? ` (${code})` : ""}`,
      );
    }
  }

  private async read(credentialId: string): Promise<VaultPayload | null> {
    const response = await this.call(
      "read",
      this.endpoint("data", credentialId),
      { method: "GET" },
    );
    if (response.statusCode === 404) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Vault credential read failed (HTTP ${response.statusCode})`,
      );
    }
    return parseVaultPayload(response.body, credentialId);
  }

  async get(descriptor: CredentialDescriptor): Promise<Buffer | null> {
    const payload = await this.read(descriptor.id);
    if (!payload) return null;
    if (payload.kind !== descriptor.kind) {
      throw new Error("Vault returned an invalid credential payload");
    }
    return Buffer.from(payload.value, "base64");
  }

  // Adoption only needs to know what a stored secret is, so the value is parsed for
  // validation and then dropped rather than returned to the caller.
  async describe(credentialId: string): Promise<AdoptableCredential | null> {
    const payload = await this.read(credentialId);
    if (!payload) return null;
    return {
      id: credentialId,
      kind: payload.kind,
      ownerId: payload.ownerId,
    };
  }

  async list(): Promise<string[]> {
    const found: string[] = [];
    const pending: Array<{ path: string; depth: number }> = [
      { path: "", depth: 0 },
    ];
    while (pending.length) {
      const { path, depth } = pending.shift()!;
      for (const key of await this.listKeys(path)) {
        if (found.length >= VAULT_MAX_LIST_ENTRIES) return found;
        const child = path
          ? `${path}/${key.replace(/\/$/, "")}`
          : key.replace(/\/$/, "");
        if (!key.endsWith("/")) {
          found.push(child);
          continue;
        }
        if (depth + 1 < VAULT_MAX_LIST_DEPTH) {
          pending.push({ path: child, depth: depth + 1 });
        }
      }
    }
    return found;
  }

  private async listKeys(path: string): Promise<string[]> {
    const base = this.prefixEndpoint("metadata");
    const url = `${path ? `${base}/${encodePath(path)}` : base}?list=true`;
    const response = await this.call("list", url, { method: "GET" });
    if (response.statusCode === 404) return [];
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Vault credential list failed (HTTP ${response.statusCode})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error("Vault returned an invalid credential listing");
    }
    const keys = (parsed as { data?: { keys?: unknown } } | null)?.data?.keys;
    if (!Array.isArray(keys)) {
      throw new Error("Vault returned an invalid credential listing");
    }
    return keys.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
  }

  async set(
    descriptor: CredentialDescriptor,
    value: Uint8Array,
  ): Promise<void> {
    this.assertWritable(descriptor.id);
    const response = await this.call(
      "write",
      this.endpoint("data", descriptor.id),
      {
        method: "POST",
        body: JSON.stringify({
          data: {
            value: Buffer.from(value).toString("base64"),
            version: 1,
            kind: descriptor.kind,
            ownerId: descriptor.ownerId ?? null,
          },
        }),
      },
    );
    if (response.statusCode === 403) throw this.deniedError(descriptor.id);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Vault credential write failed (HTTP ${response.statusCode})`,
      );
    }
  }

  async delete(descriptor: CredentialDescriptor): Promise<void> {
    this.assertWritable(descriptor.id);
    const response = await this.call(
      "delete",
      this.endpoint("metadata", descriptor.id),
      { method: "DELETE" },
    );
    if (response.statusCode === 403) throw this.deniedError(descriptor.id);
    if (
      response.statusCode !== 404 &&
      (response.statusCode < 200 || response.statusCode >= 300)
    ) {
      throw new Error(
        `Vault credential delete failed (HTTP ${response.statusCode})`,
      );
    }
  }
}
