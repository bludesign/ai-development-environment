import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AsyncEntry } from "@napi-rs/keyring";
import { lock, type LockOptions } from "proper-lockfile";

import { getAppSecrets, parseAppSecretMaterial } from "@/lib/app-secret";

const KEYCHAIN_SERVICE = "com.bludesign.ai-development-environment.app-secret";
const KEYCHAIN_ACCOUNT = "APP_SECRET";

type KeychainModule = {
  AsyncEntry: new (
    service: string,
    account: string,
  ) => Pick<AsyncEntry, "getPassword" | "setPassword">;
};

// Dependency injection keeps tests away from the user's real login Keychain.
type InitializerOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  directory?: string;
  service?: string;
  loadKeychain?: () => Promise<KeychainModule>;
  acquireLock?: (
    directory: string,
    options: LockOptions,
  ) => Promise<() => Promise<void>>;
};

function keychainError(operation: string): Error {
  // Native errors must not accidentally include secret material in startup logs.
  return new Error(
    `Could not ${operation} APP_SECRET in macOS Keychain. Unlock your login Keychain and grant access to the server, or configure APP_SECRET explicitly.`,
  );
}

/** Internal factory; overrides are for isolated tests, never runtime settings. */
export function createAppSecretInitializer(options: InitializerOptions = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const directory =
    options.directory ?? join(homedir(), ".ai-development-environment");
  const loadKeychain =
    options.loadKeychain ?? (() => import("@napi-rs/keyring"));
  const acquireLock = options.acquireLock ?? lock;
  let initialization: Promise<void> | undefined;

  async function readOrCreateSecret(): Promise<string> {
    let entry: InstanceType<KeychainModule["AsyncEntry"]>;
    try {
      const { AsyncEntry } = await loadKeychain();
      entry = new AsyncEntry(
        options.service ?? KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT,
      );
    } catch {
      throw keychainError("open");
    }

    async function read(): Promise<string | null> {
      let value: string | null;
      try {
        value = await entry.getPassword();
      } catch {
        throw keychainError("read");
      }
      // Only a genuinely missing entry permits creation. Empty or malformed
      // entries must not silently replace a root used by another server.
      if (value === null) return null;
      try {
        parseAppSecretMaterial(value, "Keychain APP_SECRET");
      } catch {
        throw new Error(
          "The macOS Keychain APP_SECRET is invalid. Restore its original base64 or hex encoding of 32 bytes, or configure APP_SECRET explicitly. The stored entry has not been replaced.",
        );
      }
      return value.trim();
    }

    const existing = await read();
    if (existing !== null) return existing;

    let release: () => Promise<void>;
    let compromised = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      release = await acquireLock(directory, {
        lockfilePath: join(directory, "app-secret.lock"),
        stale: 10_000,
        update: 5_000,
        retries: { retries: 150, factor: 1, minTimeout: 200, maxTimeout: 200 },
        onCompromised: () => {
          compromised = true;
        },
      });
    } catch {
      throw new Error(
        "Could not acquire the APP_SECRET initialization lock under ~/.ai-development-environment. Check directory permissions and retry startup, or configure APP_SECRET explicitly.",
      );
    }

    try {
      // Another process may have created the account-wide entry while we waited.
      const current = await read();
      if (compromised) throw keychainError("safely initialize");
      if (current !== null) return current;

      const generated = randomBytes(32).toString("base64");
      try {
        await entry.setPassword(generated);
      } catch {
        throw keychainError("store");
      }
      // Do not expose an unpersisted root to authentication or signing callers.
      const persisted = await read();
      if (compromised || persisted !== generated) {
        throw keychainError("confirm persistence of");
      }
      return persisted;
    } finally {
      try {
        await release();
      } catch {
        throw keychainError("release the initialization lock for");
      }
    }
  }

  return async function initialize(): Promise<void> {
    const configured = env.APP_SECRET?.trim();
    if (configured) {
      parseAppSecretMaterial(configured, "APP_SECRET");
      return;
    }
    if (env.NEXT_PHASE === "phase-production-build") return;
    if (env.CREDENTIAL_STORAGE_TYPE?.trim().toLowerCase() !== "keychain") {
      // Preserve the existing requirement for database, Vault, and unknown stores.
      getAppSecrets(env);
      return;
    }
    if (platform !== "darwin") {
      throw new Error(
        "Automatic APP_SECRET storage in Keychain is only available on macOS. Configure APP_SECRET explicitly on this host.",
      );
    }

    initialization ??= readOrCreateSecret()
      .then((secret) => {
        // An explicit value supplied while initialization was pending still wins.
        if (env.APP_SECRET?.trim()) {
          parseAppSecretMaterial(env.APP_SECRET, "APP_SECRET");
        } else {
          env.APP_SECRET = secret;
        }
      })
      .finally(() => {
        initialization = undefined;
      });
    await initialization;
  };
}

const globalForAppSecret = globalThis as typeof globalThis & {
  appSecretInitializer?: () => Promise<void>;
};

/** Resolve the root before loading services with synchronous secret consumers. */
export async function initializeAppSecret(): Promise<void> {
  globalForAppSecret.appSecretInitializer ??= createAppSecretInitializer();
  await globalForAppSecret.appSecretInitializer();
}
