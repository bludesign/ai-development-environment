#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argumentsToForward = process.argv.slice(2);
const skipSetupIndex = argumentsToForward.indexOf("--skip-setup");
const skipSetup = skipSetupIndex !== -1;
if (skipSetup) argumentsToForward.splice(skipSetupIndex, 1);

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

function configuredPort(name) {
  const value = process.env[name];
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return String(port);
}

async function screenshotEnvironment() {
  const environment = { ...process.env };
  const ports = new Set();
  for (const name of ["SCREENSHOT_PORT", "MOCK_API_PORT", "AGENT_WS_PORT"]) {
    let port = configuredPort(name);
    if (port && ports.has(port)) {
      throw new Error(`${name} duplicates another screenshot port: ${port}`);
    }
    while (!port || ports.has(port)) port = await availablePort();
    ports.add(port);
    environment[name] = port;
  }
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

const environment = await screenshotEnvironment();
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
