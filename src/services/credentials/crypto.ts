import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import type { CredentialDescriptor } from "./types";

export const CREDENTIAL_ENVELOPE_VERSION = 1;
export const CREDENTIAL_NONCE_BYTES = 12;
export const CREDENTIAL_AUTH_TAG_BYTES = 16;

export type EncryptedCredential = {
  payload: Buffer;
  encryptionVersion: number;
  nonce: Buffer;
  authTag: Buffer;
  keyFingerprint: string;
};

export function parseCredentialEncryptionKey(value: string): Buffer {
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must be strict base64 encoding of exactly 32 bytes",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must be strict base64 encoding of exactly 32 bytes",
    );
  }
  return key;
}

export function credentialKeyFingerprint(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex");
}

function authenticatedData(
  descriptor: Pick<CredentialDescriptor, "id" | "kind">,
  version: number,
): Buffer {
  return Buffer.from(
    JSON.stringify({ id: descriptor.id, kind: descriptor.kind, version }),
    "utf8",
  );
}

export function encryptCredential(
  descriptor: Pick<CredentialDescriptor, "id" | "kind">,
  plaintext: Uint8Array,
  key: Uint8Array,
): EncryptedCredential {
  const nonce = randomBytes(CREDENTIAL_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: CREDENTIAL_AUTH_TAG_BYTES,
  });
  cipher.setAAD(authenticatedData(descriptor, CREDENTIAL_ENVELOPE_VERSION));
  const payload = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
  return {
    payload,
    encryptionVersion: CREDENTIAL_ENVELOPE_VERSION,
    nonce,
    authTag: cipher.getAuthTag(),
    keyFingerprint: credentialKeyFingerprint(key),
  };
}

export function decryptCredential(
  descriptor: Pick<CredentialDescriptor, "id" | "kind">,
  encrypted: {
    payload: Uint8Array;
    encryptionVersion: number;
    nonce: Uint8Array;
    authTag: Uint8Array;
  },
  key: Uint8Array,
): Buffer {
  if (encrypted.encryptionVersion !== CREDENTIAL_ENVELOPE_VERSION) {
    throw new Error(
      "The credential encryption envelope version is unsupported",
    );
  }
  if (
    encrypted.nonce.byteLength !== CREDENTIAL_NONCE_BYTES ||
    encrypted.authTag.byteLength !== CREDENTIAL_AUTH_TAG_BYTES
  ) {
    throw new Error("The credential encryption envelope is invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce, {
      authTagLength: CREDENTIAL_AUTH_TAG_BYTES,
    });
    decipher.setAAD(authenticatedData(descriptor, encrypted.encryptionVersion));
    decipher.setAuthTag(Buffer.from(encrypted.authTag));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.payload)),
      decipher.final(),
    ]);
  } catch {
    throw new Error(
      "The credential could not be decrypted; restore the original encryption key or re-enter the credential",
    );
  }
}
