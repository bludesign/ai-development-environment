#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const standaloneDirectory = path.join(repoRoot, ".next", "standalone");
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function waitForStatus(port) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            "{ health credentialStoreStatus { storageType state warnings { code } } }",
        }),
      });
      const body = await response.json();
      if (response.ok && body.data) return body.data;
      lastError = new Error(JSON.stringify(body));
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error("Standalone server did not become ready");
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function scenario(databaseUrl, storageType) {
  const port = await freePort();
  const agentPort = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: standaloneDirectory,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      AGENT_WS_HOSTNAME: "127.0.0.1",
      AGENT_WS_PORT: String(agentPort),
      DATABASE_URL: databaseUrl,
      CREDENTIAL_STORAGE_TYPE: storageType,
      ...(storageType === "database"
        ? { CREDENTIAL_ENCRYPTION_KEY: encryptionKey }
        : { CREDENTIAL_ENCRYPTION_KEY: "" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    logs = `${logs}${chunk}`.slice(-20_000);
  });
  try {
    const result = await waitForStatus(port);
    if (result.health !== "ok") throw new Error(`Health was ${result.health}`);
    return result.credentialStoreStatus;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\n${logs}`,
    );
  } finally {
    await stop(child);
  }
}

const directory = await mkdtemp(
  path.join(
    process.platform === "win32" ? os.tmpdir() : "/tmp",
    "ade-standalone-credentials-",
  ),
);
try {
  const databasePath = path.join(directory, "standalone.db");
  await writeFile(databasePath, "", { flag: "wx" });
  const databaseUrl = `file:${databasePath}`;
  await run(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );

  const database = await scenario(databaseUrl, "database");
  if (database.storageType !== "DATABASE" || database.state !== "READY") {
    throw new Error(
      `Database standalone status was unexpected: ${JSON.stringify(database)}`,
    );
  }

  if (process.platform !== "darwin") {
    const keychain = await scenario(databaseUrl, "keychain");
    const warningCodes = keychain.warnings.map(({ code }) => code);
    if (
      keychain.storageType !== "KEYCHAIN" ||
      keychain.state !== "ERROR" ||
      !warningCodes.includes("KEYCHAIN_UNSUPPORTED_PLATFORM")
    ) {
      throw new Error(
        `Linux Keychain status was unexpected: ${JSON.stringify(keychain)}`,
      );
    }
  }
  console.log("Standalone credential backend smoke checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
