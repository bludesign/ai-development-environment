// @vitest-environment node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getAppSecrets, parseAppSecretMaterial } from "@/lib/app-secret";

import { createAppSecretInitializer } from "./initialize-app-secret";

const ROOT = randomBytes(32).toString("base64");
const run = promisify(execFile);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-app-secret-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fixture(initial: string | null = null) {
  let stored = initial;
  const env: Record<string, string | undefined> = {
    CREDENTIAL_STORAGE_TYPE: "keychain",
  };
  const getPassword = vi.fn(async (): Promise<string | null> => stored);
  const setPassword = vi.fn(async (value: string) => {
    stored = value;
  });
  const constructor = vi.fn();
  const loadKeychain = vi.fn(async () => ({
    AsyncEntry: class {
      constructor(service: string, account: string) {
        constructor(service, account);
      }
      getPassword = getPassword;
      setPassword = setPassword;
    },
  }));
  const options = { env, directory, platform: "darwin" as const, loadKeychain };
  return { env, getPassword, setPassword, constructor, loadKeychain, options };
}

describe("initializeAppSecret", () => {
  test("persists a 32-byte root in its own entry and reuses it after a restart", async () => {
    const f = fixture();
    await createAppSecretInitializer(f.options)();
    expect(
      parseAppSecretMaterial(f.env.APP_SECRET!, "APP_SECRET"),
    ).toHaveLength(32);
    expect(f.constructor).toHaveBeenCalledWith(
      "com.bludesign.ai-development-environment.app-secret",
      "APP_SECRET",
    );
    const first = getAppSecrets(f.env);
    delete f.env.APP_SECRET;
    await createAppSecretInitializer(f.options)();
    expect(getAppSecrets(f.env)).toEqual(first);
    expect(f.setPassword).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  test.each([ROOT, ` \n${ROOT}\t`, randomBytes(32).toString("hex")])(
    "validates an explicit environment root without loading Keychain",
    async (secret) => {
      const f = fixture();
      f.env.APP_SECRET = secret;
      await createAppSecretInitializer(f.options)();
      expect(f.env.APP_SECRET).toBe(secret);
      expect(f.loadKeychain).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    },
  );

  test("rejects an invalid explicit root without consulting Keychain", async () => {
    const f = fixture(ROOT);
    f.env.APP_SECRET = "invalid-env-secret";
    await expect(createAppSecretInitializer(f.options)()).rejects.toThrow(
      /APP_SECRET must be/,
    );
    expect(f.loadKeychain).not.toHaveBeenCalled();
  });

  test.each([undefined, "", " \n\t"])(
    "treats an unset or blank environment root as absent",
    async (secret) => {
      const f = fixture(` ${ROOT}\n`);
      f.env.APP_SECRET = secret;
      f.env.CREDENTIAL_STORAGE_TYPE = " KeyChain ";
      await createAppSecretInitializer(f.options)();
      expect(f.env.APP_SECRET).toBe(ROOT);
      expect(f.setPassword).not.toHaveBeenCalled();
    },
  );

  test.each(["", "bad-keychain-secret", " "])(
    "rejects malformed stored roots without replacing them",
    async (stored) => {
      const f = fixture(stored);
      await expect(createAppSecretInitializer(f.options)()).rejects.toThrow(
        /Keychain APP_SECRET is invalid/,
      );
      expect(f.env.APP_SECRET).toBeUndefined();
      expect(f.setPassword).not.toHaveBeenCalled();
    },
  );

  test("builds never load Keychain or populate a runtime root", async () => {
    const f = fixture();
    f.env.NEXT_PHASE = "phase-production-build";
    await createAppSecretInitializer(f.options)();
    expect(f.loadKeychain).not.toHaveBeenCalled();
    expect(f.env.APP_SECRET).toBeUndefined();
    expect(getAppSecrets(f.env).ephemeral).toBe(true);
  });

  test.each([undefined, "database", "vault", "unknown"])(
    "continues requiring an explicit root for %s storage",
    async (backend) => {
      const f = fixture();
      f.env.CREDENTIAL_STORAGE_TYPE = backend;
      await expect(createAppSecretInitializer(f.options)()).rejects.toThrow(
        /APP_SECRET is required/,
      );
      expect(f.loadKeychain).not.toHaveBeenCalled();
    },
  );

  test.each(["linux", "win32"] as const)(
    "does not load native Keychain code on %s",
    async (platform) => {
      const f = fixture();
      await expect(
        createAppSecretInitializer({ ...f.options, platform })(),
      ).rejects.toThrow(/only available on macOS/);
      expect(f.loadKeychain).not.toHaveBeenCalled();
      f.env.APP_SECRET = ROOT;
      await createAppSecretInitializer({ ...f.options, platform })();
      expect(f.loadKeychain).not.toHaveBeenCalled();
    },
  );

  test("shares pending initialization across concurrent calls", async () => {
    const f = fixture();
    const initialize = createAppSecretInitializer(f.options);
    await Promise.all(Array.from({ length: 10 }, () => initialize()));
    expect(f.loadKeychain).toHaveBeenCalledTimes(1);
    expect(f.setPassword).toHaveBeenCalledTimes(1);
  });

  test("rechecks the entry after another initializer releases the lock", async () => {
    const f = fixture();
    const otherEnv = { CREDENTIAL_STORAGE_TYPE: "keychain" };
    await Promise.all([
      createAppSecretInitializer(f.options)(),
      createAppSecretInitializer({ ...f.options, env: otherEnv })(),
    ]);
    expect(otherEnv).toEqual(f.env);
    expect(f.setPassword).toHaveBeenCalledTimes(1);
  });

  test("recovers an abandoned initialization lock", async () => {
    const f = fixture();
    const lockPath = join(directory, "app-secret.lock");
    await mkdir(lockPath);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);
    await createAppSecretInitializer(f.options)();
    expect(f.setPassword).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  test("creates an owner-only directory for initialization", async () => {
    const f = fixture();
    const privateDirectory = join(directory, "private");
    await createAppSecretInitializer({
      ...f.options,
      directory: privateDirectory,
    })();
    if (process.platform !== "win32") {
      expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(privateDirectory)).toEqual([]);
  });

  test("does not publish a root when the native module cannot be opened", async () => {
    const f = fixture();
    f.loadKeychain.mockRejectedValue(new Error("native load failed"));
    await expect(createAppSecretInitializer(f.options)()).rejects.toThrow(
      /Could not open APP_SECRET/,
    );
    expect(f.env.APP_SECRET).toBeUndefined();
  });

  test("does not overwrite inaccessible entries and permits retry after unlocking", async () => {
    const f = fixture(ROOT);
    f.getPassword.mockRejectedValueOnce(new Error("locked"));
    const initialize = createAppSecretInitializer(f.options);
    await expect(initialize()).rejects.toThrow(/Unlock your login Keychain/);
    expect(f.env.APP_SECRET).toBeUndefined();
    expect(f.setPassword).not.toHaveBeenCalled();
    await initialize();
    expect(f.env.APP_SECRET).toBe(ROOT);
  });

  test("releases the lock after a failed write and never logs native secret values", async () => {
    const f = fixture();
    f.setPassword.mockRejectedValue(new Error(`access denied ${ROOT}`));
    const result = createAppSecretInitializer(f.options)();
    await expect(result).rejects.toThrow(/Could not store APP_SECRET/);
    await expect(result).rejects.not.toThrow(ROOT);
    expect(f.env.APP_SECRET).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  test.each([null, ROOT, "invalid"])(
    "does not publish a root when persistence cannot be confirmed (%s)",
    async (stored) => {
      const f = fixture();
      f.getPassword
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(stored);
      await expect(createAppSecretInitializer(f.options)()).rejects.toThrow(
        /Could not confirm persistence|Keychain APP_SECRET is invalid/,
      );
      expect(f.env.APP_SECRET).toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    },
  );

  test("does not publish a root when lock acquisition fails", async () => {
    const f = fixture();
    const acquireLock = vi.fn().mockRejectedValue(new Error("busy"));
    await expect(
      createAppSecretInitializer({ ...f.options, acquireLock })(),
    ).rejects.toThrow(/initialization lock/);
    expect(f.env.APP_SECRET).toBeUndefined();
    expect(f.setPassword).not.toHaveBeenCalled();
  });

  test("does not publish a root when the lock is compromised", async () => {
    const f = fixture();
    const release = vi.fn(async () => undefined);
    const acquireLock: NonNullable<
      Parameters<typeof createAppSecretInitializer>[0]
    >["acquireLock"] = async (_path, options) => {
      options.onCompromised?.(new Error("lock lost"));
      return release;
    };
    await expect(
      createAppSecretInitializer({ ...f.options, acquireLock })(),
    ).rejects.toThrow(/safely initialize/);
    expect(release).toHaveBeenCalledOnce();
    expect(f.setPassword).not.toHaveBeenCalled();
    expect(f.env.APP_SECRET).toBeUndefined();
  });

  test("does not publish a root when lock release fails", async () => {
    const f = fixture();
    const acquireLock = vi.fn(async () => async () => {
      throw new Error("lock lost");
    });
    await expect(
      createAppSecretInitializer({ ...f.options, acquireLock })(),
    ).rejects.toThrow(/release the initialization lock/);
    expect(f.env.APP_SECRET).toBeUndefined();
  });

  test("separate processes competing on first startup use one persisted root", async () => {
    const fixturePath = resolve("test/fixtures/app-secret-process.mts");
    const results = await Promise.all(
      ["first", "second"].map((id) =>
        run(
          process.execPath,
          [
            "--conditions=react-server",
            "--import",
            "tsx",
            fixturePath,
            directory,
            id,
          ],
          { timeout: 15_000 },
        ),
      ),
    );
    expect(results[0].stdout.trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(results[0].stdout).toBe(results[1].stdout);
    expect(await readFile(join(directory, "writes"), "utf8")).toBe("created\n");
  });

  test.skipIf(
    process.platform !== "darwin" ||
      process.env.RUN_KEYCHAIN_INTEGRATION_TEST !== "true",
  )(
    "creates and reuses an isolated native Keychain entry, then cleans up",
    async () => {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      const service = `com.bludesign.ai-development-environment.app-secret.test.${randomUUID()}`;
      const entry = new AsyncEntry(service, "APP_SECRET");
      const env: Record<string, string | undefined> = {
        CREDENTIAL_STORAGE_TYPE: "keychain",
      };
      try {
        await createAppSecretInitializer({ env, directory, service })();
        const first = getAppSecrets(env);
        delete env.APP_SECRET;
        await createAppSecretInitializer({ env, directory, service })();
        expect(getAppSecrets(env)).toEqual(first);
        expect(await entry.getPassword()).toBe(env.APP_SECRET);
      } finally {
        await entry.deleteCredential();
      }
    },
  );
});
