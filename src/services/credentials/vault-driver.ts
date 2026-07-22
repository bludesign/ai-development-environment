import { readFile } from "node:fs/promises";

import { Agent, request, type Dispatcher } from "undici";

import type { VaultCredentialStoreConfig } from "./config";
import type { CredentialDriver } from "./driver";
import type { CredentialDescriptor } from "./types";

const VAULT_REQUEST_TIMEOUT_MS = 10_000;
// A supported 20 MiB p12 is base64-encoded by its owning JSON credential and then again
// for Vault storage. Keep enough headroom for both expansions and Vault's response envelope.
const VAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export type VaultRequest = typeof request;
export type VaultDispatcherFactory = (
  options: ConstructorParameters<typeof Agent>[0],
) => Dispatcher;

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
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
  private dispatcherPromise: Promise<Dispatcher> | null = null;

  constructor(
    private readonly config: VaultCredentialStoreConfig,
    private readonly requestImplementation: VaultRequest = request,
    private readonly dispatcherFactory: VaultDispatcherFactory = (options) =>
      new Agent(options),
  ) {}

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
    const base = this.config.address.toString().replace(/\/+$/, "");
    return `${base}/v1/${encodePath(this.config.mount)}/${area}/${encodePath(
      this.config.pathPrefix,
    )}/${encodePath(credentialId)}`;
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
    operation: "read" | "write" | "delete",
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

  async get(descriptor: CredentialDescriptor): Promise<Buffer | null> {
    const response = await this.call(
      "read",
      this.endpoint("data", descriptor.id),
      { method: "GET" },
    );
    if (response.statusCode === 404) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Vault credential read failed (HTTP ${response.statusCode})`,
      );
    }
    try {
      const parsed = JSON.parse(response.body) as {
        data?: {
          data?: { value?: unknown; version?: unknown; kind?: unknown };
        };
      };
      const value = parsed.data?.data?.value;
      if (
        typeof value !== "string" ||
        parsed.data?.data?.version !== 1 ||
        parsed.data?.data?.kind !== descriptor.kind
      ) {
        throw new Error("invalid payload");
      }
      return Buffer.from(value, "base64");
    } catch {
      throw new Error("Vault returned an invalid credential payload");
    }
  }

  async set(
    descriptor: CredentialDescriptor,
    value: Uint8Array,
  ): Promise<void> {
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
          },
        }),
      },
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Vault credential write failed (HTTP ${response.statusCode})`,
      );
    }
  }

  async delete(descriptor: CredentialDescriptor): Promise<void> {
    const response = await this.call(
      "delete",
      this.endpoint("metadata", descriptor.id),
      { method: "DELETE" },
    );
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
