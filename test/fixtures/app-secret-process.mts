// A fake persistent Keychain with the real inter-process initialization lock.
// Never imports the native adapter or accesses the user's login Keychain.
import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { getAppSecrets } from "../../src/lib/app-secret";
import { createAppSecretInitializer } from "../../src/server/initialize-app-secret";

const [directory, id] = process.argv.slice(2);
const env: Record<string, string | undefined> = {
  CREDENTIAL_STORAGE_TYPE: "keychain",
};
let firstRead = true;
await createAppSecretInitializer({
  env,
  platform: "darwin",
  directory,
  loadKeychain: async () => ({
    AsyncEntry: class {
      async getPassword(): Promise<string | null> {
        if (firstRead) {
          firstRead = false;
          await writeFile(join(directory, `${id}.ready`), "");
          const deadline = Date.now() + 5_000;
          while (
            (await readdir(directory)).filter((name) => name.endsWith(".ready"))
              .length < 2
          ) {
            if (Date.now() > deadline)
              throw new Error("Other process did not start");
            await setTimeout(10);
          }
          return null;
        }
        try {
          return await readFile(join(directory, "fake-keychain"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      }
      async setPassword(value: string): Promise<void> {
        await writeFile(join(directory, "fake-keychain"), value, {
          flag: "wx",
          mode: 0o600,
        });
        await appendFile(join(directory, "writes"), "created\n");
        await setTimeout(50);
      }
    },
  }),
})();
process.stdout.write(
  `${createHash("sha256").update(getAppSecrets(env).authSecret).digest("hex")}\n`,
);
