#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a screenshot port");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return String(address.port);
}

function configuredPort(name, environment) {
  const value = environment[name];
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return String(port);
}

export async function builtAgentWebSocketPort(buildRoot = root) {
  const manifestPath = path.join(
    buildRoot,
    ".next-mock",
    "routes-manifest.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Screenshot build not found at ${manifestPath}. Run npm run screenshots before using --skip-setup.`,
      );
    }
    throw new Error(`Unable to read screenshot routes from ${manifestPath}`, {
      cause: error,
    });
  }

  const rewriteGroups = Array.isArray(manifest.rewrites)
    ? [manifest.rewrites]
    : Object.values(manifest.rewrites ?? {}).filter(Array.isArray);
  const graphqlRewrite = rewriteGroups
    .flat()
    .find((rewrite) => rewrite?.source === "/graphql");
  if (typeof graphqlRewrite?.destination !== "string") {
    throw new Error(
      `Screenshot build at ${manifestPath} does not contain the /graphql rewrite. Rebuild it with npm run screenshots.`,
    );
  }

  let destination;
  try {
    destination = new URL(graphqlRewrite.destination);
  } catch (error) {
    throw new Error(
      `Screenshot build has an invalid /graphql destination: ${graphqlRewrite.destination}`,
      { cause: error },
    );
  }
  const port = destination.port;
  if (!port) {
    throw new Error(
      `Screenshot build /graphql destination has no explicit port: ${graphqlRewrite.destination}`,
    );
  }
  return configuredPort("build-time AGENT_WS_PORT", {
    "build-time AGENT_WS_PORT": port,
  });
}

export async function screenshotEnvironment({
  skipSetup = false,
  environmentVariables = process.env,
  buildRoot = root,
  allocatePort = availablePort,
} = {}) {
  const environment = { ...environmentVariables };
  const ports = new Set();
  let agentWebSocketPort = configuredPort(
    "AGENT_WS_PORT",
    environmentVariables,
  );
  if (skipSetup) {
    const buildTimePort = await builtAgentWebSocketPort(buildRoot);
    if (agentWebSocketPort && agentWebSocketPort !== buildTimePort) {
      throw new Error(
        `AGENT_WS_PORT ${agentWebSocketPort} does not match the screenshot build port ${buildTimePort}. Rebuild with npm run screenshots or unset AGENT_WS_PORT.`,
      );
    }
    agentWebSocketPort = buildTimePort;
  }
  if (agentWebSocketPort) ports.add(agentWebSocketPort);

  for (const name of ["SCREENSHOT_PORT"]) {
    let port = configuredPort(name, environmentVariables);
    if (port && ports.has(port)) {
      throw new Error(`${name} duplicates another screenshot port: ${port}`);
    }
    while (!port || ports.has(port)) port = await allocatePort();
    ports.add(port);
    environment[name] = port;
  }
  if (!agentWebSocketPort) {
    do agentWebSocketPort = await allocatePort();
    while (ports.has(agentWebSocketPort));
  }
  environment.AGENT_WS_PORT = agentWebSocketPort;
  environment.MOCK_API_PORT = "4322";
  return environment;
}

async function run(command, args, environment) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} stopped by ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

async function main() {
  const argumentsToForward = process.argv.slice(2);
  const skipSetupIndex = argumentsToForward.indexOf("--skip-setup");
  const skipSetup = skipSetupIndex !== -1;
  if (skipSetup) argumentsToForward.splice(skipSetupIndex, 1);

  const environment = await screenshotEnvironment({ skipSetup });
  console.log(
    `Screenshot ports: app=${environment.SCREENSHOT_PORT}, mock=${environment.MOCK_API_PORT}, instrumentation=${environment.AGENT_WS_PORT}`,
  );

  if (!skipSetup) {
    for (const script of [
      "generate",
      "screenshots:browsers",
      "mock:db",
      "mock:seed",
      "screenshots:build",
    ]) {
      await run("npm", ["run", script], environment);
    }
  }

  const playwright = path.join(root, "node_modules", ".bin", "playwright");
  await run(playwright, ["test", ...argumentsToForward], environment);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
