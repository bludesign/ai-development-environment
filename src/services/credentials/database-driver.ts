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

type SqliteWalCheckpointResult = {
  busy: number | bigint;
};

async function truncateSqliteWal(prisma: PrismaClient): Promise<void> {
  const [result] = await prisma.$queryRawUnsafe<SqliteWalCheckpointResult[]>(
    "PRAGMA wal_checkpoint(TRUNCATE);",
  );
  if (!result || Number(result.busy) !== 0) {
    throw new Error(
      "SQLite WAL could not be truncated after credential encryption",
    );
  }
}

async function erasePlaintextRemnants(prisma: PrismaClient): Promise<void> {
  // First replace the plaintext main-database pages with their encrypted WAL versions.
  await truncateSqliteWal(prisma);
  // VACUUM securely rebuilds the database now that secure_delete is enabled. In WAL mode
  // that rebuild can itself create frames, so require one final truncating checkpoint.
  await prisma.$executeRawUnsafe("VACUUM;");
  await truncateSqliteWal(prisma);
}

export class DatabaseCredentialDriver implements CredentialDriver {
  readonly storageType = "database" as const;
  readonly readOnly = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: DatabaseCredentialStoreConfig,
  ) {}

  async initialize(): Promise<void> {
    const encryptionKey = this.config.encryptionKey;

    // This connection setting makes SQLite overwrite content released by each update.
    // Leave it enabled so subsequent credential replacements and deletions receive the
    // same protection.
    await this.prisma.$queryRawUnsafe("PRAGMA secure_delete = ON;");

    // Rotation runs first, so rows sealed under a previous APP_SECRET are brought
    // forward before the fingerprint check below would reject them.
    await this.reencryptRotatedRows();

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

    const mismatched = encryptedRows.some(
      (row) => row.keyFingerprint !== this.config.keyFingerprint,
    );
    if (mismatched) {
      throw new CredentialStoreOperationError(
        "APP_SECRET does not match existing credentials. Restore the original value, or set APP_SECRET_PREVIOUS to it so stored credentials are re-encrypted on the next start.",
        "CREDENTIAL_KEY_MISMATCH",
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

    // Databases written before encryption became unconditional can still hold
    // plaintext rows; this upgrades all of them atomically.
    const sweptRows = await this.prisma.$transaction(async (transaction) => {
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
      return plaintextRows.length;
    });
    if (sweptRows > 0) await erasePlaintextRemnants(this.prisma);
  }

  /**
   * Re-seals rows encrypted under a key derived from APP_SECRET_PREVIOUS.
   *
   * Idempotent: rows already carrying the current fingerprint are not selected, so
   * an interrupted run simply resumes. A row that matches no supplied key is left
   * alone for the caller's mismatch check to report, rather than being dropped.
   */
  private async reencryptRotatedRows(): Promise<number> {
    const previousKeys = this.config.previousKeys;
    if (previousKeys.length === 0) return 0;

    const staleRows = await this.prisma.credential.findMany({
      where: {
        storageType: this.storageType,
        encrypted: true,
        keyFingerprint: { not: this.config.keyFingerprint },
      },
      select: {
        id: true,
        kind: true,
        payload: true,
        encryptionVersion: true,
        nonce: true,
        authTag: true,
      },
    });
    if (staleRows.length === 0) return 0;

    const rotated = await this.prisma.$transaction(async (transaction) => {
      let count = 0;
      for (const row of staleRows) {
        if (
          !row.payload ||
          !row.encryptionVersion ||
          !row.nonce ||
          !row.authTag
        ) {
          throw invalidCredential(
            `Credential ${row.id} has invalid encryption metadata and cannot be rotated`,
          );
        }
        const descriptor = {
          id: row.id,
          kind: row.kind as CredentialDescriptor["kind"],
        };
        const encrypted = {
          payload: row.payload,
          encryptionVersion: row.encryptionVersion,
          nonce: row.nonce,
          authTag: row.authTag,
        };
        let plaintext: Buffer | null = null;
        for (const key of previousKeys) {
          try {
            plaintext = decryptCredential(descriptor, encrypted, key);
            break;
          } catch {
            // Try the next previous key; AES-GCM authentication makes a wrong key
            // a clean failure rather than silent garbage.
          }
        }
        if (!plaintext) continue;

        const resealed = encryptCredential(
          descriptor,
          plaintext,
          this.config.encryptionKey,
        );
        await transaction.credential.update({
          where: { id: row.id },
          data: {
            payload: prismaBytes(resealed.payload),
            encryptionVersion: resealed.encryptionVersion,
            nonce: prismaBytes(resealed.nonce),
            authTag: prismaBytes(resealed.authTag),
            keyFingerprint: resealed.keyFingerprint,
          },
        });
        count += 1;
      }
      return count;
    });
    // The superseded ciphertext is released database content, so scrub it the same
    // way the plaintext upgrade does.
    if (rotated > 0) await erasePlaintextRemnants(this.prisma);
    return rotated;
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
    if (record.keyFingerprint !== this.config.keyFingerprint) {
      throw new CredentialStoreOperationError(
        "APP_SECRET does not match this credential",
        "CREDENTIAL_KEY_MISMATCH",
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
    const encryption = encryptCredential(
      descriptor,
      value,
      this.config.encryptionKey,
    );
    const data = {
      kind: descriptor.kind,
      ownerId: descriptor.ownerId ?? null,
      storageType: this.storageType,
      payload: prismaBytes(encryption.payload),
      encrypted: true,
      encryptionVersion: encryption.encryptionVersion,
      nonce: prismaBytes(encryption.nonce),
      authTag: prismaBytes(encryption.authTag),
      keyFingerprint: encryption.keyFingerprint,
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
