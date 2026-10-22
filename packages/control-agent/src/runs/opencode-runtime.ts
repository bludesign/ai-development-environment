import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { configPath } from "../config.js";
import { findExecutable } from "../executable-lookup.js";

const execute = promisify(execFile);
export const supportedOpenCodeVersion = (version: string): boolean => {
  const match = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return (
    !!match &&
    Number(match[1]) === 2 &&
    (Number(match[2]) > 1 || (Number(match[2]) === 1 && Number(match[3]) >= 1))
  );
};

/** Registrations belong to this agent, separately from the user's shared service. */
export class OpenCodeRuntime {
  private starting?: Promise<{ client: OpenCodeClient; version: string }>;
  private current?: { client: OpenCodeClient; version: string };
  private stopped = false;
  readonly file: string;
  private readonly stateDirectory: string;
  constructor(private readonly isolated = false) {
    this.stateDirectory = join(
      dirname(configPath()),
      "opencode",
      isolated ? `run-${randomUUID()}` : "agent",
    );
    this.file = join(this.stateDirectory, "opencode", "service.json");
  }
  client(): Promise<{ client: OpenCodeClient; version: string }> {
    if (this.stopped)
      return Promise.reject(new Error("OpenCode runtime is closed"));
    return (this.starting ??= this.connect().finally(() => {
      this.starting = undefined;
    }));
  }
  private async connect() {
    if (this.current) {
      try {
        await this.current.client.server.info({
          signal: AbortSignal.timeout(5_000),
        });
        return this.current;
      } catch {
        this.current = undefined;
      }
    }
    return (this.current = await this.start());
  }
  private async start() {
    const override = process.env.CONTROL_AGENT_OPENCODE_EXECUTABLE?.trim();
    const executable = findExecutable("opencode", {
      overrideVariable: "CONTROL_AGENT_OPENCODE_EXECUTABLE",
    });
    if (!executable || (override && executable !== override))
      throw new Error(
        "OpenCode 2 was not found. Install npm install -g @opencode/cli@2.1.1 or brew install anomalyco/tap/opencode-v2, or set CONTROL_AGENT_OPENCODE_EXECUTABLE to its full path.",
      );
    const { stdout } = await execute(executable, ["--version"], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (!supportedOpenCodeVersion(stdout))
      throw new Error(
        `OpenCode >=2.1.1 <3 is required; found ${stdout.trim()}`,
      );
    const version = stdout.trim().replace(/^(?:opencode\s+)?v?/, "");
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      // The client reads `file`, but the native CLI derives its registration
      // from XDG_STATE_HOME. Both must point to the same private registration.
      const endpoint = await Service.ensure({
        file: this.file,
        env: { XDG_STATE_HOME: this.stateDirectory },
        // Replace an older owned service after a CLI upgrade, even when its
        // API version is still supported.
        version,
        command: [
          executable,
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          "0",
        ],
      });
      const client = OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      });
      const info = await client.server.info({
        signal: AbortSignal.timeout(10_000),
      });
      if (!supportedOpenCodeVersion(info.version))
        throw new Error(`Unsupported OpenCode server version: ${info.version}`);
      if (info.version !== version)
        throw new Error(
          `OpenCode server version ${info.version} does not match installed CLI ${version}`,
        );
      return { client, version: info.version };
    } catch (error) {
      await Service.stop({ file: this.file }).catch(() => undefined);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.starting || this.current) {
      await this.starting?.catch(() => undefined);
      await Service.stop({ file: this.file });
      this.starting = undefined;
      this.current = undefined;
    }
    if (this.isolated)
      await rm(this.stateDirectory, { recursive: true, force: true });
  }
}

/** Read-only discovery never starts or stops the user's service. */
export async function sharedOpenCodeClient(): Promise<
  OpenCodeClient | undefined
> {
  const endpoint = await Service.discover({
    version: supportedOpenCodeVersion,
  });
  return endpoint
    ? OpenCode.make({
        baseUrl: endpoint.url,
        headers: Service.headers(endpoint),
      })
    : undefined;
}
