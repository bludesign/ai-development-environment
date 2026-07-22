import type {
  Credential,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";

import type { DatabaseCredentialStoreConfig } from "./config";
import { decryptCredential, encryptCredential } from "./crypto";
import { CredentialStoreOperationError, type CredentialDriver } from "./driver";
import type { CredentialDescriptor } from "./types";

type CredentialTransaction = Prisma.TransactionClient;
type CredentialRecord = Pick<
  Credential,
  | "id"
  | "kind"
  | "storageType"
  | "payload"
  | "encrypted"
  | "encryptionVersion"
  | "nonce"
  | "authTag"
  | "keyFingerprint"
>;

function invalidCredential(message: string): CredentialStoreOperationError {
  return new CredentialStoreOperationError(message, "CREDENTIAL_DATA_INVALID");
}

function prismaBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

export class DatabaseCredentialDriver implements CredentialDriver {
  readonly storageType = "database" as const;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: DatabaseCredentialStoreConfig,
  ) {}

  async initialize(): Promise<void> {
    const encryptedRows = await this.prisma.credential.findMany({
      where: { storageType: this.storageType, encrypted: true },
      select: {
        id: true,
        keyFingerprint: true,
        encryptionVersion: true,
        nonce: true,
        authTag: true,
        payload: true,
      },
    });
    if (encryptedRows.length && !this.config.encryptionKey) {
      throw new CredentialStoreOperationError(
        "Encrypted credentials exist, but CREDENTIAL_ENCRYPTION_KEY is not configured. Restore the original key and restart the server.",
        "CREDENTIAL_ENCRYPTION_KEY_MISSING",
      );
    }
    if (this.config.encryptionKey) {
      const encryptionKey = this.config.encryptionKey;
      const mismatched = encryptedRows.some(
        (row) => row.keyFingerprint !== this.config.keyFingerprint,
      );
      if (mismatched) {
        throw new CredentialStoreOperationError(
          "CREDENTIAL_ENCRYPTION_KEY does not match existing credentials. Restore the original key and restart the server.",
          "CREDENTIAL_ENCRYPTION_KEY_MISMATCH",
        );
      }
      const malformed = encryptedRows.some(
        (row) =>
          !row.payload ||
          row.encryptionVersion !== 1 ||
          !row.nonce ||
          !row.authTag,
      );
      if (malformed) {
        throw invalidCredential(
          "One or more encrypted credential records have invalid encryption metadata",
        );
      }

      // Adding a valid key later upgrades every plaintext database credential atomically.
      await this.prisma.$transaction(async (transaction) => {
        const plaintextRows = await transaction.credential.findMany({
          where: { storageType: this.storageType, encrypted: false },
          select: { id: true, kind: true, payload: true },
        });
        for (const row of plaintextRows) {
          if (!row.payload) {
            throw invalidCredential(
              `Credential metadata for ${row.id} has no database payload`,
            );
          }
          const encrypted = encryptCredential(
            { id: row.id, kind: row.kind as CredentialDescriptor["kind"] },
            row.payload,
            encryptionKey,
          );
          await transaction.credential.update({
            where: { id: row.id },
            data: {
              payload: prismaBytes(encrypted.payload),
              encrypted: true,
              encryptionVersion: encrypted.encryptionVersion,
              nonce: prismaBytes(encrypted.nonce),
              authTag: prismaBytes(encrypted.authTag),
              keyFingerprint: encrypted.keyFingerprint,
            },
          });
        }
      });
    }
  }

  async get(descriptor: CredentialDescriptor): Promise<Buffer | null> {
    const record = await this.prisma.credential.findUnique({
      where: { id: descriptor.id },
    });
    if (!record) return null;
    return this.getFromRecord(descriptor, record);
  }

  getFromRecord(
    descriptor: CredentialDescriptor,
    record: CredentialRecord,
  ): Buffer {
    if (record.kind !== descriptor.kind) {
      throw invalidCredential(
        `Credential ${descriptor.id} has unexpected kind metadata`,
      );
    }
    if (record.storageType !== this.storageType) {
      throw new CredentialStoreOperationError(
        `Credential ${descriptor.id} was stored in ${record.storageType}; re-enter it for database storage`,
        "BACKEND_MISMATCH",
      );
    }
    if (!record.payload) {
      throw invalidCredential(
        `Credential ${descriptor.id} has no database payload`,
      );
    }
    if (!record.encrypted) return Buffer.from(record.payload);
    if (!this.config.encryptionKey) {
      throw new CredentialStoreOperationError(
        "CREDENTIAL_ENCRYPTION_KEY is required to read encrypted credentials",
        "CREDENTIAL_ENCRYPTION_KEY_MISSING",
      );
    }
    if (record.keyFingerprint !== this.config.keyFingerprint) {
      throw new CredentialStoreOperationError(
        "CREDENTIAL_ENCRYPTION_KEY does not match this credential",
        "CREDENTIAL_ENCRYPTION_KEY_MISMATCH",
      );
    }
    if (!record.encryptionVersion || !record.nonce || !record.authTag) {
      throw invalidCredential(
        `Credential ${descriptor.id} has invalid encryption metadata`,
      );
    }
    return decryptCredential(
      descriptor,
      {
        payload: record.payload,
        encryptionVersion: record.encryptionVersion,
        nonce: record.nonce,
        authTag: record.authTag,
      },
      this.config.encryptionKey,
    );
  }

  async set(
    descriptor: CredentialDescriptor,
    value: Uint8Array,
  ): Promise<void> {
    await this.prisma.$transaction((transaction) =>
      this.setInTransaction(transaction, descriptor, value),
    );
  }

  async setInTransaction(
    transaction: CredentialTransaction,
    descriptor: CredentialDescriptor,
    value: Uint8Array,
  ): Promise<void> {
    const encryption = this.config.encryptionKey
      ? encryptCredential(descriptor, value, this.config.encryptionKey)
      : null;
    const data = {
      kind: descriptor.kind,
      ownerId: descriptor.ownerId ?? null,
      storageType: this.storageType,
      payload: prismaBytes(encryption?.payload ?? value),
      encrypted: Boolean(encryption),
      encryptionVersion: encryption?.encryptionVersion ?? null,
      nonce: encryption ? prismaBytes(encryption.nonce) : null,
      authTag: encryption ? prismaBytes(encryption.authTag) : null,
      keyFingerprint: encryption?.keyFingerprint ?? null,
    };
    await transaction.credential.upsert({
      where: { id: descriptor.id },
      create: { id: descriptor.id, ...data },
      update: data,
    });
  }

  async delete(descriptor: CredentialDescriptor): Promise<void> {
    await this.prisma.$transaction((transaction) =>
      this.deleteInTransaction(transaction, descriptor),
    );
  }

  async deleteInTransaction(
    transaction: CredentialTransaction,
    descriptor: CredentialDescriptor,
  ): Promise<void> {
    await transaction.credential.deleteMany({ where: { id: descriptor.id } });
  }
}
