import type { CredentialDescriptor, CredentialStorageType } from "./types";

export interface CredentialDriver {
  readonly storageType: CredentialStorageType;
  initialize(): Promise<void>;
  get(descriptor: CredentialDescriptor): Promise<Buffer | null>;
  set(descriptor: CredentialDescriptor, value: Uint8Array): Promise<void>;
  delete(descriptor: CredentialDescriptor): Promise<void>;
}

export class CredentialStoreOperationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CREDENTIAL_ENCRYPTION_KEY_MISSING"
      | "CREDENTIAL_ENCRYPTION_KEY_MISMATCH"
      | "CREDENTIAL_DATA_INVALID"
      | "VAULT_CONFIGURATION_INVALID"
      | "KEYCHAIN_UNSUPPORTED_PLATFORM"
      | "BACKEND_MISMATCH",
  ) {
    super(message);
    this.name = "CredentialStoreOperationError";
  }
}
