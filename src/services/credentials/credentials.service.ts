import "server-only";

import { getPrismaClient } from "@/data/prisma-client";
import type { Credential, PrismaClient } from "@/generated/prisma/client";

import {
  readCredentialStoreConfig,
  type CredentialStoreConfig,
  type CredentialStoreConfigResult,
  type CredentialEnvironment,
} from "./config";
import { DatabaseCredentialDriver } from "./database-driver";
import { CredentialStoreOperationError, type CredentialDriver } from "./driver";
import {
  KeychainCredentialDriver,
  type KeychainModuleLoader,
} from "./keychain-driver";
import type {
  CredentialDescriptor,
  CredentialMetadataView,
  CredentialMutation,
  CredentialProtection,
  CredentialStorageType,
  CredentialStoreIssue,
  CredentialStoreStatusView,
} from "./types";
import {
  credentialOwnerFeature,
  decodeJsonCredential,
  encodeJsonCredential,
} from "./types";
import {
  VaultCredentialDriver,
  type VaultDispatcherFactory,
  type VaultRequest,
} from "./vault-driver";

type CredentialServiceOptions = {
  env?: CredentialEnvironment;
  platform?: NodeJS.Platform;
  prisma?: PrismaClient;
  prismaFactory?: () => Promise<PrismaClient>;
  keychainModuleLoader?: KeychainModuleLoader;
  vaultRequest?: VaultRequest;
  vaultDispatcherFactory?: VaultDispatcherFactory;
};

function knownStorageType(value: string): CredentialStorageType | "unknown" {
  return value === "database" || value === "vault" || value === "keychain"
    ? value
    : "unknown";
}

function protection(record: {
  storageType: string;
  encrypted: boolean;
}): CredentialProtection {
  if (record.storageType === "vault") return "VAULT";
  if (record.storageType === "keychain") return "KEYCHAIN";
  return record.encrypted ? "ENCRYPTED" : "PLAINTEXT";
}

function uniqueIssues(issues: CredentialStoreIssue[]): CredentialStoreIssue[] {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.code}:${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class CredentialService {
  private readonly env: CredentialEnvironment;
  private readonly platform: NodeJS.Platform;
  private readonly configResult: CredentialStoreConfigResult;
  private readonly prismaFactory: () => Promise<PrismaClient>;
  private prismaPromise: Promise<PrismaClient> | null = null;
  private driverPromise: Promise<CredentialDriver> | null = null;
  private initializationPromise: Promise<void> | null = null;
  private runtimeIssue: CredentialStoreIssue | null = null;
  private readonly keychainModuleLoader?: KeychainModuleLoader;
  private readonly vaultRequest?: VaultRequest;
  private readonly vaultDispatcherFactory?: VaultDispatcherFactory;

  constructor(options: CredentialServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.configResult = readCredentialStoreConfig(this.env, this.platform);
    this.prismaFactory = options.prisma
      ? async () => options.prisma!
      : (options.prismaFactory ?? getPrismaClient);
    this.keychainModuleLoader = options.keychainModuleLoader;
    this.vaultRequest = options.vaultRequest;
    this.vaultDispatcherFactory = options.vaultDispatcherFactory;
  }

  private prisma(): Promise<PrismaClient> {
    return (this.prismaPromise ??= this.prismaFactory());
  }

  private configurationError(): Error | null {
    const first = this.configResult.errors[0];
    return first
      ? new Error(`Credential storage is not configured: ${first.message}`)
      : null;
  }

  private async createDriver(
    config: CredentialStoreConfig,
  ): Promise<CredentialDriver> {
    if (config.storageType === "database") {
      return new DatabaseCredentialDriver(await this.prisma(), config);
    }
    if (config.storageType === "vault") {
      return new VaultCredentialDriver(
        config,
        this.vaultRequest,
        this.vaultDispatcherFactory,
      );
    }
    return new KeychainCredentialDriver(config, this.keychainModuleLoader);
  }

  private driver(): Promise<CredentialDriver> {
    if (!this.driverPromise) {
      this.driverPromise = (async () => {
        const configurationError = this.configurationError();
        if (configurationError) throw configurationError;
        if (!this.configResult.config) {
          throw new Error("Credential storage is not configured");
        }
        return this.createDriver(this.configResult.config);
      })();
    }
    return this.driverPromise;
  }

  async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        const driver = await this.driver();
        await driver.initialize();
      })().catch((error: unknown) => {
        if (this.configResult.errors.length === 0) {
          this.runtimeIssue = this.issueForInitializationError(error);
        }
        throw error;
      });
    }
    return this.initializationPromise;
  }

  private issueForInitializationError(error: unknown): CredentialStoreIssue {
    if (error instanceof CredentialStoreOperationError) {
      return { code: error.code, message: error.message };
    }
    if (this.configResult.storageType === "vault") {
      return {
        code: "VAULT_CONFIGURATION_INVALID",
        message: "Vault TLS configuration could not be initialized",
      };
    }
    return {
      code: "CREDENTIAL_STORE_UNAVAILABLE",
      message:
        error instanceof Error
          ? error.message
          : "Credential storage could not be initialized",
    };
  }

  private async requireCurrentDriver(): Promise<CredentialDriver> {
    await this.ensureInitialized();
    return this.driver();
  }

  async get(descriptor: CredentialDescriptor): Promise<Buffer | null> {
    const driver = await this.requireCurrentDriver();
    const prisma = await this.prisma();
    const record = await prisma.credential.findUnique({
      where: { id: descriptor.id },
    });
    if (!record) return null;
    if (record.kind !== descriptor.kind) {
      throw new CredentialStoreOperationError(
        `Credential ${descriptor.id} has unexpected kind metadata`,
        "CREDENTIAL_DATA_INVALID",
      );
    }
    if (record.storageType !== driver.storageType) {
      throw new CredentialStoreOperationError(
        `Credential ${descriptor.id} was stored in ${record.storageType}; re-enter it for ${driver.storageType} storage`,
        "BACKEND_MISMATCH",
      );
    }
    const value =
      driver instanceof DatabaseCredentialDriver
        ? driver.getFromRecord(descriptor, record)
        : await driver.get(descriptor);
    if (!value) {
      throw new Error(
        `Credential ${descriptor.id} is missing from ${driver.storageType}; re-enter it in its owning settings form`,
      );
    }
    return value;
  }

  async getText(descriptor: CredentialDescriptor): Promise<string | null> {
    const value = await this.get(descriptor);
    return value ? value.toString("utf8") : null;
  }

  async getJson<T>(descriptor: CredentialDescriptor): Promise<T | null> {
    const value = await this.get(descriptor);
    return value ? decodeJsonCredential<T>(value) : null;
  }

  async isConfigured(descriptor: CredentialDescriptor): Promise<boolean> {
    const record = await (
      await this.prisma()
    ).credential.findUnique({
      where: { id: descriptor.id },
      select: { kind: true, storageType: true },
    });
    return Boolean(
      record &&
      record.kind === descriptor.kind &&
      record.storageType === this.configResult.storageType,
    );
  }

  async set(
    descriptor: CredentialDescriptor,
    value: Uint8Array,
    mutation?: CredentialMutation,
  ): Promise<void> {
    await this.setMany([{ descriptor, value }], mutation);
  }

  async setMany(
    entries: Array<{
      descriptor: CredentialDescriptor;
      value: Uint8Array;
    }>,
    mutation?: CredentialMutation,
  ): Promise<void> {
    const ids = entries.map((entry) => entry.descriptor.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("Credential writes must use unique IDs");
    }
    const driver = await this.requireCurrentDriver();
    const prisma = await this.prisma();
    if (driver instanceof DatabaseCredentialDriver) {
      await prisma.$transaction(async (transaction) => {
        for (const entry of entries) {
          await driver.setInTransaction(
            transaction,
            entry.descriptor,
            entry.value,
          );
        }
        await mutation?.(transaction);
      });
      return;
    }

    const previous = new Map<string, Buffer | null>();
    for (const entry of entries) {
      previous.set(entry.descriptor.id, await driver.get(entry.descriptor));
    }
    const attempted: typeof entries = [];
    try {
      for (const entry of entries) {
        attempted.push(entry);
        await driver.set(entry.descriptor, entry.value);
      }
      await prisma.$transaction(async (transaction) => {
        for (const { descriptor } of entries) {
          await transaction.credential.upsert({
            where: { id: descriptor.id },
            create: {
              id: descriptor.id,
              kind: descriptor.kind,
              ownerId: descriptor.ownerId ?? null,
              storageType: driver.storageType,
            },
            update: {
              kind: descriptor.kind,
              ownerId: descriptor.ownerId ?? null,
              storageType: driver.storageType,
              payload: null,
              encrypted: false,
              encryptionVersion: null,
              nonce: null,
              authTag: null,
              keyFingerprint: null,
            },
          });
        }
        await mutation?.(transaction);
      });
    } catch (error) {
      try {
        for (const entry of attempted.reverse()) {
          const oldValue = previous.get(entry.descriptor.id);
          if (oldValue) await driver.set(entry.descriptor, oldValue);
          else await driver.delete(entry.descriptor);
        }
      } catch {
        throw new Error(
          `Credential metadata could not be saved and the ${driver.storageType} rollback also failed; re-enter the affected credentials`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async setText(
    descriptor: CredentialDescriptor,
    value: string,
    mutation?: CredentialMutation,
  ): Promise<void> {
    await this.set(descriptor, Buffer.from(value, "utf8"), mutation);
  }

  async setJson<T>(
    descriptor: CredentialDescriptor,
    value: T,
    mutation?: CredentialMutation,
  ): Promise<void> {
    await this.set(descriptor, encodeJsonCredential(value), mutation);
  }

  private async driverForRecordedStorage(
    storageType: CredentialStorageType,
  ): Promise<CredentialDriver> {
    const current = await this.requireCurrentDriver();
    if (current.storageType === storageType) return current;
    const result = readCredentialStoreConfig(
      { ...this.env, CREDENTIAL_STORAGE_TYPE: storageType },
      this.platform,
    );
    if (!result.config || result.errors.length) {
      throw new Error(
        `Cannot delete the credential from its recorded ${storageType} backend: ${
          result.errors[0]?.message ?? "backend configuration is unavailable"
        }`,
      );
    }
    const driver = await this.createDriver(result.config);
    // Deleting a database payload does not require decrypting it or initializing its key.
    if (!(driver instanceof DatabaseCredentialDriver))
      await driver.initialize();
    return driver;
  }

  async delete(
    descriptor: CredentialDescriptor,
    mutation?: CredentialMutation,
  ): Promise<void> {
    await this.deleteMany([descriptor], mutation);
  }

  async deleteMany(
    descriptors: CredentialDescriptor[],
    mutation?: CredentialMutation,
  ): Promise<void> {
    await this.ensureInitialized();
    const ids = descriptors.map((descriptor) => descriptor.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error("Credential deletes must use unique IDs");
    }
    const prisma = await this.prisma();
    const records = await prisma.credential.findMany({
      where: { id: { in: ids } },
      select: { id: true, kind: true, storageType: true },
    });
    if (!records.length) {
      if (mutation) await prisma.$transaction(mutation);
      return;
    }
    const descriptorById = new Map(
      descriptors.map((descriptor) => [descriptor.id, descriptor]),
    );
    const external: Array<{
      descriptor: CredentialDescriptor;
      driver: CredentialDriver;
      previous: Buffer | null;
    }> = [];
    for (const record of records) {
      const descriptor = descriptorById.get(record.id)!;
      if (record.kind !== descriptor.kind) {
        throw new CredentialStoreOperationError(
          `Credential ${descriptor.id} has unexpected kind metadata`,
          "CREDENTIAL_DATA_INVALID",
        );
      }
      const recordedStorage = knownStorageType(record.storageType);
      if (recordedStorage === "unknown") {
        throw new CredentialStoreOperationError(
          `Credential ${descriptor.id} has an unknown backend`,
          "CREDENTIAL_DATA_INVALID",
        );
      }
      const driver = await this.driverForRecordedStorage(recordedStorage);
      if (!(driver instanceof DatabaseCredentialDriver)) {
        external.push({
          descriptor,
          driver,
          previous: await driver.get(descriptor),
        });
      }
    }
    const deleted: typeof external = [];
    try {
      for (const entry of external) {
        deleted.push(entry);
        await entry.driver.delete(entry.descriptor);
      }
      await prisma.$transaction(async (transaction) => {
        await transaction.credential.deleteMany({
          where: { id: { in: records.map((record) => record.id) } },
        });
        await mutation?.(transaction);
      });
    } catch (error) {
      try {
        for (const entry of deleted.reverse()) {
          if (entry.previous) {
            await entry.driver.set(entry.descriptor, entry.previous);
          }
        }
      } catch {
        throw new Error(
          "Credential metadata could not be deleted and an external-backend rollback also failed; re-enter the affected credentials",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async list(): Promise<CredentialMetadataView[]> {
    const rows = await (
      await this.prisma()
    ).credential.findMany({
      select: {
        id: true,
        kind: true,
        ownerId: true,
        storageType: true,
        encrypted: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ kind: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      ownerId: row.ownerId,
      ownerFeature: credentialOwnerFeature(row.kind),
      storageType: knownStorageType(row.storageType),
      protection: protection(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async status(): Promise<CredentialStoreStatusView> {
    try {
      await this.ensureInitialized();
    } catch {
      // The status endpoint reports initialization errors without taking down the app.
    }
    const rows = await (
      await this.prisma()
    ).credential.findMany({
      select: { storageType: true, encrypted: true },
    });
    const mismatchCount = rows.filter(
      (row) => row.storageType !== this.configResult.storageType,
    ).length;
    const mismatchIssue: CredentialStoreIssue[] = mismatchCount
      ? [
          {
            code: "BACKEND_MISMATCH",
            message: `${mismatchCount} credential item${
              mismatchCount === 1 ? " was" : "s were"
            } stored with another backend and must be re-entered`,
          },
        ]
      : [];
    const warnings = uniqueIssues([
      ...this.configResult.warnings,
      ...this.configResult.errors,
      ...(this.runtimeIssue ? [this.runtimeIssue] : []),
      ...mismatchIssue,
    ]);
    const hasError =
      this.configResult.errors.length > 0 || Boolean(this.runtimeIssue);
    const encryptionState = hasError
      ? ("ERROR" as const)
      : this.configResult.storageType === "database"
        ? this.configResult.config?.storageType === "database" &&
          this.configResult.config.encryptionKey
          ? ("ENCRYPTED" as const)
          : ("PLAINTEXT" as const)
        : ("EXTERNAL" as const);
    return {
      storageType: this.configResult.storageType,
      state: hasError ? "ERROR" : warnings.length ? "WARNING" : "READY",
      encryptionState,
      details: this.configResult.details,
      itemCount: rows.length,
      mismatchCount,
      warnings,
    };
  }
}

export type CredentialRecordForTests = Credential;
