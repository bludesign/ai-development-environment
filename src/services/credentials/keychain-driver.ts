import type { KeychainCredentialStoreConfig } from "./config";
import type { CredentialDriver } from "./driver";
import { CredentialStoreOperationError } from "./driver";
import type { CredentialDescriptor } from "./types";

type KeychainEntry = {
  getSecret(signal?: AbortSignal | null): Promise<Uint8Array | undefined>;
  setSecret(secret: Uint8Array, signal?: AbortSignal | null): Promise<void>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
};

type KeychainModule = {
  AsyncEntry: new (service: string, username: string) => KeychainEntry;
};

export type KeychainModuleLoader = () => Promise<KeychainModule>;

const loadNativeKeychain: KeychainModuleLoader = () =>
  import("@napi-rs/keyring");

export class KeychainCredentialDriver implements CredentialDriver {
  readonly storageType = "keychain" as const;

  constructor(
    private readonly config: KeychainCredentialStoreConfig,
    private readonly moduleLoader: KeychainModuleLoader = loadNativeKeychain,
  ) {}

  async initialize(): Promise<void> {
    this.assertSupported();
    // Rendering status must never load the native binding or prompt the login Keychain.
  }

  private assertSupported(): void {
    if (this.config.platform !== "darwin") {
      throw new CredentialStoreOperationError(
        "macOS Keychain credential storage is unavailable on this host. Select database or Vault storage and restart the server.",
        "KEYCHAIN_UNSUPPORTED_PLATFORM",
      );
    }
  }

  private async entry(id: string): Promise<KeychainEntry> {
    this.assertSupported();
    const { AsyncEntry } = await this.moduleLoader();
    return new AsyncEntry(this.config.service, id);
  }

  async get(descriptor: CredentialDescriptor): Promise<Buffer | null> {
    try {
      const secret = await (await this.entry(descriptor.id)).getSecret();
      return secret ? Buffer.from(secret) : null;
    } catch (error) {
      throw new Error(
        `macOS Keychain could not read ${descriptor.id}: ${
          error instanceof Error ? error.message : "credential operation failed"
        }`,
      );
    }
  }

  async set(
    descriptor: CredentialDescriptor,
    value: Uint8Array,
  ): Promise<void> {
    try {
      await (await this.entry(descriptor.id)).setSecret(Buffer.from(value));
    } catch (error) {
      throw new Error(
        `macOS Keychain could not store ${descriptor.id}: ${
          error instanceof Error ? error.message : "credential operation failed"
        }`,
      );
    }
  }

  async delete(descriptor: CredentialDescriptor): Promise<void> {
    try {
      await (await this.entry(descriptor.id)).deleteCredential();
    } catch (error) {
      throw new Error(
        `macOS Keychain could not delete ${descriptor.id}: ${
          error instanceof Error ? error.message : "credential operation failed"
        }`,
      );
    }
  }
}
