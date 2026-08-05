import type {
  CredentialDescriptor,
  CredentialKind,
  CredentialStorageType,
} from "./types";

// Metadata recovered from a backend that already holds the secret. Adoption rebuilds the
// Credential rows a fresh install is missing, so it never needs the secret bytes.
export type AdoptableCredential = {
  id: string;
  kind: CredentialKind;
  ownerId: string | null;
};

export interface CredentialDriver {
  readonly storageType: CredentialStorageType;
  // Only the Vault driver can report true; database and keychain are always writable.
  readonly readOnly: boolean;
  initialize(): Promise<void>;
  get(descriptor: CredentialDescriptor): Promise<Buffer | null>;
  set(descriptor: CredentialDescriptor, value: Uint8Array): Promise<void>;
  delete(descriptor: CredentialDescriptor): Promise<void>;
  // Describes one stored credential without returning its value. Absent when the backend
  // owns the metadata itself and has nothing to adopt.
  describe?(id: string): Promise<AdoptableCredential | null>;
  // Enumerates stored credential IDs. Absent when the backend cannot be enumerated.
  list?(): Promise<string[]>;
}

export class CredentialStoreOperationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CREDENTIAL_KEY_MISMATCH"
      | "CREDENTIAL_DATA_INVALID"
      | "CREDENTIAL_STORE_READ_ONLY"
      | "VAULT_CONFIGURATION_INVALID"
      | "KEYCHAIN_UNSUPPORTED_PLATFORM"
      | "BACKEND_MISMATCH",
  ) {
    super(message);
    this.name = "CredentialStoreOperationError";
  }
}
