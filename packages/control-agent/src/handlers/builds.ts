import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawn } from "node:child_process";

import {
  parseBuildDeploymentPayload,
  parseBuildDeletePayload,
  parseBuildArtifactDownloadPayload,
  parseBuildDestinationsPayload,
  parseBuildExportPayload,
  parseBuildJobPayload,
  parseBuildRunDestinationsPayload,
  parseBuildSourceDiscoverPayload,
  parseBuildSourceParsePayload,
  GENERIC_BUILD_DESTINATION_ACTIONS,
  type BuildAction,
  type BuildAdvancedSettings,
  type BuildDestination,
  type BuildExportSettings,
  type BuildJobPayload,
  type BuildSourceSnapshot,
} from "@ai-development-environment/agent-contract/builds";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

import { captureCommand, type CaptureResult } from "../capture-command.js";
import type { ProcessResult } from "../process-runner.js";
import type { AgentJobHandler, AgentJobHandlerContext } from "./index.js";

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;
const DISCOVERY_LIMIT = 500;
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".build",
  ".next",
  "DerivedData",
  "build",
  "node_modules",
]);

type BuildLogEvent = {
  scope: string;
  scopeId: string;
  sequence: number;
  phase: string;
  level: string;
  stream: string;
  message: string;
  createdAt: string;
};

type CommandResult = ProcessResult & {
  output: string;
};

type Artifact = {
  kind: string;
  relativePath: string;
  sizeBytes: number | null;
  checksum: string | null;
  metadata: Record<string, unknown>;
};

function cleanError(value: unknown): string {
  return createRedactor(process.env)(
    value instanceof Error ? value.message : String(value),
  )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
    .slice(0, 4_000);
}

function command(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureResult> {
  return captureCommand({
    command: executable,
    args,
    timeoutMs,
    signal,
    cwd,
    env,
  });
}

function requireSuccess(
  result: CaptureResult,
  fallback: string,
): CaptureResult {
  if (result.cancelled) throw new Error("Operation was cancelled");
  if (result.timedOut) throw new Error("Operation timed out");
  if (result.exitCode !== 0) {
    throw new Error(cleanError(result.stderr || result.stdout || fallback));
  }
  return result;
}

async function validateWorktree(
  input: {
    folder: string;
    gitDirectory: string;
    expectedOrigin: string;
  },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const folder = await realpath(input.folder);
  if (!(await stat(folder)).isDirectory())
    throw new Error("Worktree is missing");
  const gitDirectory = requireSuccess(
    await command(
      "git",
      ["-C", folder, "rev-parse", "--path-format=absolute", "--git-dir"],
      timeoutMs,
      signal,
      folder,
      { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    ),
    "Could not resolve the worktree Git directory",
  ).stdout.trim();
  if ((await realpath(gitDirectory)) !== input.gitDirectory) {
    throw new Error("Worktree identity changed; refresh the page");
  }
  const origin = requireSuccess(
    await command(
      "git",
      ["-C", folder, "remote", "get-url", "origin"],
      timeoutMs,
      signal,
      folder,
      { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    ),
    "Repository does not have an origin remote",
  ).stdout.trim();
  if (normalizeGitOrigin(origin).canonicalOrigin !== input.expectedOrigin) {
    throw new Error("Worktree origin changed; refresh the codebase");
  }
  return folder;
}

function containedPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const difference = relative(root, target);
  if (
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("Path must stay within the worktree");
  }
  return target;
}

async function validateSource(
  root: string,
  source: BuildSourceSnapshot,
): Promise<string> {
  const target = containedPath(root, source.relativePath);
  const resolved = await realpath(target);
  const difference = relative(root, resolved);
  if (
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("Build source resolves outside the worktree");
  }
  const information = await stat(resolved);
  if (source.kind === "PACKAGE" && !information.isFile()) {
    throw new Error("Package.swift is missing");
  }
  if (source.kind !== "PACKAGE" && !information.isDirectory()) {
    throw new Error("Xcode source is missing");
  }
  return resolved;
}

async function discoverSourcesInFolder(folder: string) {
  const sources: Array<{ kind: string; relativePath: string }> = [];
  const queue = [folder];
  while (queue.length && sources.length < DISCOVERY_LIMIT) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(current, entry.name);
      const path = relative(folder, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".xcodeproj")) {
          sources.push({ kind: "PROJECT", relativePath: path });
        } else if (entry.name.endsWith(".xcworkspace")) {
          sources.push({ kind: "WORKSPACE", relativePath: path });
        } else if (!SKIP_DIRECTORIES.has(entry.name)) {
          queue.push(absolute);
        }
      } else if (
        entry.isFile() &&
        entry.name === "Package.swift" &&
        current === folder
      ) {
        sources.push({ kind: "PACKAGE", relativePath: "Package.swift" });
      }
      if (sources.length >= DISCOVERY_LIMIT) break;
    }
  }
  return sources.sort((first, second) =>
    first.relativePath.localeCompare(second.relativePath),
  );
}

function parseJson(value: string, name: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${name} is not an object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Could not parse ${name}: ${cleanError(error)}`);
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((first, second) =>
    first.localeCompare(second),
  );
}

function sourceArguments(
  source: BuildSourceSnapshot,
  absolutePath: string,
): string[] {
  if (source.kind === "PROJECT") return ["-project", absolutePath];
  if (source.kind === "WORKSPACE") return ["-workspace", absolutePath];
  return [];
}

async function xcodeList(
  source: BuildSourceSnapshot,
  absolutePath: string,
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const cwd = source.kind === "PACKAGE" ? folder : folder;
  const result = requireSuccess(
    await command(
      "xcrun",
      [
        "xcodebuild",
        ...sourceArguments(source, absolutePath),
        "-list",
        "-json",
      ],
      timeoutMs,
      signal,
      cwd,
    ),
    "Could not inspect the Xcode source",
  );
  return parseJson(result.stdout, "xcodebuild list output");
}

function metadataFromList(value: Record<string, unknown>) {
  const container =
    (value.project as Record<string, unknown> | undefined) ??
    (value.workspace as Record<string, unknown> | undefined) ??
    {};
  return {
    schemes: strings(container.schemes),
    configurations: strings(container.configurations),
  };
}

export async function workspaceProjectPaths(
  workspacePath: string,
  folder: string,
): Promise<string[]> {
  const contentsPath = join(workspacePath, "contents.xcworkspacedata");
  let contents: string;
  try {
    contents = await readFile(contentsPath, "utf8");
  } catch {
    return [];
  }
  const locations = [...contents.matchAll(/\blocation\s*=\s*["']([^"']+)["']/g)]
    .map((match) => match[1]!)
    .flatMap((location) => {
      const separator = location.indexOf(":");
      if (separator < 0) return [];
      const kind = location.slice(0, separator);
      if (kind !== "group" && kind !== "container") return [];
      const escaped = location
        .slice(separator + 1)
        .replaceAll("&amp;", "&")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'");
      try {
        return [decodeURIComponent(escaped)];
      } catch {
        return [];
      }
    })
    .filter((path) => path.endsWith(".xcodeproj"));
  const projects: string[] = [];
  for (const location of locations) {
    const candidate = resolve(dirname(workspacePath), location);
    const difference = relative(folder, candidate);
    if (
      difference === ".." ||
      difference.startsWith(`..${sep}`) ||
      isAbsolute(difference)
    ) {
      continue;
    }
    try {
      const resolved = await realpath(candidate);
      const resolvedDifference = relative(folder, resolved);
      if (
        resolvedDifference === ".." ||
        resolvedDifference.startsWith(`..${sep}`) ||
        isAbsolute(resolvedDifference) ||
        !(await stat(resolved)).isDirectory()
      ) {
        continue;
      }
      projects.push(resolved);
    } catch {
      // Ignore missing and broken workspace references while parsing others.
    }
  }
  return uniqueSorted(projects);
}

async function workspaceConfigurations(
  workspacePath: string,
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  const candidates = (await workspaceProjectPaths(workspacePath, folder)).slice(
    0,
    50,
  );
  const configurations: string[] = [];
  for (const candidate of candidates) {
    const result = await command(
      "xcrun",
      ["xcodebuild", "-project", candidate, "-list", "-json"],
      Math.min(timeoutMs, 30_000),
      signal,
      folder,
    );
    if (result.exitCode !== 0) continue;
    configurations.push(
      ...metadataFromList(parseJson(result.stdout, "project list output"))
        .configurations,
    );
  }
  return uniqueSorted(configurations);
}

export function testPlanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueSorted(
    value.flatMap((entry): string[] => {
      if (typeof entry === "string") return [entry];
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const name = (entry as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    }),
  );
}

async function testPlans(
  source: BuildSourceSnapshot,
  absolutePath: string,
  folder: string,
  scheme: string | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  if (!scheme) return [];
  const result = await command(
    "xcrun",
    [
      "xcodebuild",
      ...sourceArguments(source, absolutePath),
      "-scheme",
      scheme,
      "-showTestPlans",
      "-json",
    ],
    Math.min(timeoutMs, 30_000),
    signal,
    folder,
  );
  if (result.exitCode !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) return uniqueSorted(strings(parsed));
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      return uniqueSorted(
        testPlanNames(record.testPlans).concat(testPlanNames(record.plans)),
      );
    }
  } catch {
    return uniqueSorted(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith(":")),
    );
  }
  return [];
}

export const discoverBuildSources: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = parseBuildSourceDiscoverPayload(payload);
  const folder = await validateWorktree(input, timeoutMs, signal);
  return {
    ...successfulProcess,
    sources: await discoverSourcesInFolder(folder),
  };
};

export const parseBuildSourceMetadata: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = parseBuildSourceParsePayload(payload);
  const folder = await validateWorktree(input, timeoutMs, signal);
  const absolutePath = await validateSource(folder, input.source);
  const [list, version] = await Promise.all([
    xcodeList(input.source, absolutePath, folder, timeoutMs, signal),
    command("xcrun", ["xcodebuild", "-version"], 15_000, signal, folder),
  ]);
  const metadata = metadataFromList(list);
  const configurations =
    input.source.kind === "PACKAGE"
      ? ["Debug", "Release"]
      : input.source.kind === "WORKSPACE" &&
          metadata.configurations.length === 0
        ? await workspaceConfigurations(absolutePath, folder, timeoutMs, signal)
        : metadata.configurations;
  return {
    ...successfulProcess,
    schemes: uniqueSorted(metadata.schemes),
    configurations: uniqueSorted(configurations),
    testPlans: await testPlans(
      input.source,
      absolutePath,
      folder,
      input.scheme,
      timeoutMs,
      signal,
    ),
    xcodeVersion:
      version.exitCode === 0
        ? version.stdout.trim().replace(/\n+/g, " · ")
        : null,
    headSha: input.headSha,
  };
};

export function simulatorDestinations(value: unknown): BuildDestination[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const devices = (value as Record<string, unknown>).devices;
  if (!devices || typeof devices !== "object" || Array.isArray(devices))
    return [];
  const result: BuildDestination[] = [];
  for (const [runtime, entries] of Object.entries(devices)) {
    if (!runtime.includes("SimRuntime.iOS-") || !Array.isArray(entries))
      continue;
    const osVersion =
      runtime.split("SimRuntime.iOS-")[1]?.replaceAll("-", ".") ?? null;
    for (const raw of entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const device = raw as Record<string, unknown>;
      if (device.isAvailable !== true || typeof device.udid !== "string")
        continue;
      result.push({
        type: "SIMULATOR",
        id: device.udid,
        name: typeof device.name === "string" ? device.name : device.udid,
        platform: "iOS Simulator",
        osVersion,
        state: typeof device.state === "string" ? device.state : null,
      });
    }
  }
  return result;
}

function nestedString(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        current = null;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === "string" && current) return current;
  }
  return null;
}

export function physicalDestinations(value: unknown): BuildDestination[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const result = (value as Record<string, unknown>).result;
  const devices =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>).devices
      : null;
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((raw): BuildDestination[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const id = nestedString(raw, [
      ["identifier"],
      ["hardwareProperties", "udid"],
      ["deviceProperties", "identifier"],
    ]);
    const platform = nestedString(raw, [
      ["hardwareProperties", "platform"],
      ["deviceProperties", "osType"],
    ]);
    if (!id || (platform && !platform.toLowerCase().includes("ios"))) return [];
    const state = nestedString(raw, [
      ["connectionProperties", "tunnelState"],
      ["deviceProperties", "connectionState"],
    ]);
    if (state && /(disconnected|unavailable|not.?connected)/i.test(state)) {
      return [];
    }
    return [
      {
        type: "PHYSICAL_DEVICE",
        id,
        name: nestedString(raw, [["deviceProperties", "name"], ["name"]]) ?? id,
        platform: "iOS",
        osVersion: nestedString(raw, [
          ["deviceProperties", "osVersionNumber"],
          ["deviceProperties", "osVersion"],
        ]),
        state,
      },
    ];
  });
}

export function genericBuildDestinations(
  action: BuildAction,
): BuildDestination[] {
  if (!GENERIC_BUILD_DESTINATION_ACTIONS.includes(action)) return [];
  const physical: BuildDestination = {
    type: "PHYSICAL_DEVICE",
    id: "generic-ios",
    name: "Any Physical iOS Device",
    platform: "iOS",
    osVersion: null,
    state: null,
    generic: true,
  };
  if (action === "ARCHIVE") return [physical];
  return [
    {
      type: "SIMULATOR",
      id: "generic-ios-simulator",
      name: "Any iOS Simulator",
      platform: "iOS Simulator",
      osVersion: null,
      state: null,
      generic: true,
    },
    physical,
  ];
}

async function listPhysicalDevices(
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BuildDestination[]> {
  const directory = await mkdtemp(join(tmpdir(), "ade-devices-"));
  const output = join(directory, "devices.json");
  try {
    const result = await command(
      "xcrun",
      [
        "devicectl",
        "list",
        "devices",
        "--quiet",
        "--timeout",
        String(Math.max(1, Math.round(Math.min(timeoutMs, 30_000) / 1_000))),
        "--json-output",
        output,
      ],
      Math.min(timeoutMs, 35_000),
      signal,
    );
    if (result.exitCode !== 0) return [];
    return physicalDestinations(JSON.parse(await readFile(output, "utf8")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const inspectBuildDestinations: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = parseBuildDestinationsPayload(payload);
  const folder = await validateWorktree(input, timeoutMs, signal);
  const absolutePath = await validateSource(folder, input.source);
  const preflight = await command(
    "xcrun",
    [
      "xcodebuild",
      ...sourceArguments(input.source, absolutePath),
      "-scheme",
      input.scheme,
      "-configuration",
      input.configuration,
      "-showBuildSettings",
      "-json",
    ],
    Math.min(timeoutMs, 60_000),
    signal,
    folder,
  );
  requireSuccess(preflight, "The saved scheme or configuration is unavailable");
  if (GENERIC_BUILD_DESTINATION_ACTIONS.includes(input.action)) {
    return {
      ...successfulProcess,
      destinations: genericBuildDestinations(input.action),
    };
  }
  const [simulators, physical] = await Promise.all([
    command(
      "xcrun",
      ["simctl", "list", "devices", "available", "-j"],
      Math.min(timeoutMs, 30_000),
      signal,
      folder,
    ),
    listPhysicalDevices(timeoutMs, signal),
  ]);
  return {
    ...successfulProcess,
    destinations: [
      ...(simulators.exitCode === 0
        ? simulatorDestinations(JSON.parse(simulators.stdout))
        : []),
      ...physical,
    ],
  };
};

export const inspectBuildRunDestinations: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = parseBuildRunDestinationsPayload(payload);
  const folder = await validateWorktree(input, timeoutMs, signal);
  if (input.destinationType === "SIMULATOR") {
    const simulators = await command(
      "xcrun",
      ["simctl", "list", "devices", "available", "-j"],
      Math.min(timeoutMs, 30_000),
      signal,
      folder,
    );
    requireSuccess(simulators, "Could not inspect available simulators");
    return {
      ...successfulProcess,
      destinations: simulatorDestinations(JSON.parse(simulators.stdout)),
    };
  }
  return {
    ...successfulProcess,
    destinations: await listPhysicalDevices(timeoutMs, signal),
  };
};

function sensitiveValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(
      ([key, value]) =>
        Boolean(value) &&
        /(token|secret|password|passwd|credential|private.?key|api.?key|cookie|authorization)/i.test(
          key,
        ),
    )
    .map(([, value]) => value!)
    .filter((value) => value.length >= 4)
    .sort((first, second) => second.length - first.length);
}

export function createRedactor(env: NodeJS.ProcessEnv) {
  const secrets = sensitiveValues(env);
  return (raw: string): string => {
    let value = raw;
    for (const secret of secrets)
      value = value.split(secret).join("[REDACTED]");
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
      .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g, "$1[REDACTED]@")
      .replace(
        /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*[^\s]+/gi,
        "$1=[REDACTED]",
      )
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        "[REDACTED PRIVATE KEY]",
      );
  };
}

class BuildLogger {
  private readonly stream;
  private readonly redact;
  private sequence = 0;
  private pending: BuildLogEvent[] = [];
  private flushChain = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closePromise: Promise<void> | null = null;
  private redactingPrivateKey = false;

  constructor(
    private readonly buildId: string,
    private readonly context: AgentJobHandlerContext | undefined,
    rawLogPath: string,
    env: NodeJS.ProcessEnv,
  ) {
    this.stream = createWriteStream(rawLogPath, { flags: "a", mode: 0o600 });
    this.redact = createRedactor(env);
  }

  emit(
    phase: string,
    stream: "STDOUT" | "STDERR" | "SYSTEM",
    message: string,
    scope = "BUILD",
    scopeId = this.buildId,
    extraStream?: ReturnType<typeof createWriteStream>,
  ): void {
    const startsPrivateKey = /-----BEGIN [^-]*PRIVATE KEY-----/i.test(message);
    const endsPrivateKey = /-----END [^-]*PRIVATE KEY-----/i.test(message);
    if (startsPrivateKey) this.redactingPrivateKey = true;
    const sanitized = this.redactingPrivateKey
      ? "[REDACTED PRIVATE KEY]"
      : this.redact(message);
    if (endsPrivateKey) this.redactingPrivateKey = false;
    const createdAt = new Date().toISOString();
    const line = `[${createdAt}] [${phase}] [${stream}] ${sanitized}\n`;
    this.stream.write(line);
    extraStream?.write(line);
    this.pending.push({
      scope,
      scopeId,
      sequence: this.sequence++,
      phase,
      level:
        stream === "STDERR" || /\berror\b/i.test(sanitized)
          ? "ERROR"
          : /\bwarning\b/i.test(sanitized)
            ? "WARNING"
            : "INFO",
      stream,
      message: sanitized,
      createdAt,
    });
    if (this.pending.length >= 100) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 250);
      this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const events = this.pending.splice(0);
    if (!events.length || !this.context?.appendBuildLogs) return;
    this.flushChain = this.flushChain.then(async () => {
      try {
        await this.context!.appendBuildLogs!(this.buildId, events);
      } catch (error) {
        console.error("Could not append build logs:", cleanError(error));
      }
    });
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.flush();
      await this.flushChain;
      await new Promise<void>((resolveClose) => this.stream.end(resolveClose));
    })();
    return this.closePromise;
  }
}

function terminateProcess(
  child: ReturnType<typeof spawn>,
): ReturnType<typeof setTimeout> | null {
  if (child.exitCode !== null || child.killed) return null;
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  timer.unref();
  return timer;
}

function runLoggedCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  logger: BuildLogger;
  phase: string;
  scope?: string;
  scopeId?: string;
  additionalLogPath?: string;
}): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let output = "";
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let extraStream: ReturnType<typeof createWriteStream> | undefined;
    if (options.additionalLogPath) {
      extraStream = createWriteStream(options.additionalLogPath, {
        flags: "a",
        mode: 0o600,
      });
    }
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    options.logger.emit(
      options.phase,
      "SYSTEM",
      `Running ${options.command} ${options.args.map((arg) => JSON.stringify(arg)).join(" ")}`,
      options.scope,
      options.scopeId,
      extraStream,
    );
    const attach = (
      stream: NodeJS.ReadableStream,
      kind: "STDOUT" | "STDERR",
    ) => {
      let remainder = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const parts = `${remainder}${chunk}`.split(/\r?\n/);
        remainder = parts.pop() ?? "";
        for (const line of parts) {
          output = `${output}${line}\n`.slice(-64_000);
          options.logger.emit(
            options.phase,
            kind,
            line,
            options.scope,
            options.scopeId,
            extraStream,
          );
        }
      });
      stream.on("end", () => {
        if (remainder) {
          output = `${output}${remainder}`.slice(-64_000);
          options.logger.emit(
            options.phase,
            kind,
            remainder,
            options.scope,
            options.scopeId,
            extraStream,
          );
        }
      });
    };
    attach(child.stdout, "STDOUT");
    attach(child.stderr, "STDERR");
    const timeout = setTimeout(() => {
      timedOut = true;
      options.logger.emit(options.phase, "SYSTEM", "Command timed out");
      killTimer ??= terminateProcess(child);
    }, options.timeoutMs);
    timeout.unref();
    const abort = () => {
      cancelled = true;
      options.logger.emit(options.phase, "SYSTEM", "Cancellation requested");
      killTimer ??= terminateProcess(child);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      extraStream?.end();
      reject(error);
    });
    child.once("close", (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      extraStream?.end();
      resolveCommand({
        exitCode,
        signal: closeSignal,
        timedOut,
        cancelled,
        output,
      });
    });
  });
}

function minimalEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "TMPDIR",
    "DEVELOPER_DIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
    "SSH_AUTH_SOCK",
  ];
  return {
    ...Object.fromEntries(
      keys.flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : [],
      ),
    ),
    ...extra,
  };
}

function xcodeEnvironment(): NodeJS.ProcessEnv {
  return minimalEnvironment({
    NSUnbufferedIO: "YES",
  });
}

function testArguments(settings: BuildAdvancedSettings): string[] {
  const args: string[] = [];
  if (settings.testPlan) args.push("-testPlan", settings.testPlan);
  if (settings.codeCoverage) args.push("-enableCodeCoverage", "YES");
  if (settings.parallelTesting !== null) {
    args.push(
      "-parallel-testing-enabled",
      settings.parallelTesting ? "YES" : "NO",
    );
  }
  if (settings.parallelTestingWorkers !== null) {
    args.push(
      "-parallel-testing-worker-count",
      String(settings.parallelTestingWorkers),
    );
  }
  for (const test of settings.onlyTesting) args.push(`-only-testing:${test}`);
  for (const test of settings.skipTesting) args.push(`-skip-testing:${test}`);
  return args;
}

function advancedArguments(settings: BuildAdvancedSettings): string[] {
  const args: string[] = [];
  if (settings.packageResolution === "RESOLVED_ONLY") {
    args.push("-onlyUsePackageVersionsFromResolvedFile");
  } else if (settings.packageResolution === "SKIP_UPDATES") {
    args.push("-skipPackageUpdates");
  } else if (settings.packageResolution === "DISABLE_AUTOMATIC") {
    args.push("-disableAutomaticPackageResolution");
  }
  if (settings.disablePackageRepositoryCache) {
    args.push("-disablePackageRepositoryCache");
  }
  if (settings.signingStyle !== "PROJECT_DEFAULT") {
    args.push(
      `CODE_SIGN_STYLE=${settings.signingStyle === "AUTOMATIC" ? "Automatic" : "Manual"}`,
    );
  }
  if (settings.developmentTeam)
    args.push(`DEVELOPMENT_TEAM=${settings.developmentTeam}`);
  if (settings.codeSignIdentity)
    args.push(`CODE_SIGN_IDENTITY=${settings.codeSignIdentity}`);
  if (settings.provisioningProfileSpecifier) {
    args.push(
      `PROVISIONING_PROFILE_SPECIFIER=${settings.provisioningProfileSpecifier}`,
    );
  }
  if (settings.productBundleIdentifier) {
    args.push(`PRODUCT_BUNDLE_IDENTIFIER=${settings.productBundleIdentifier}`);
  }
  if (settings.allowProvisioningUpdates) args.push("-allowProvisioningUpdates");
  if (settings.allowProvisioningDeviceRegistration) {
    args.push("-allowProvisioningDeviceRegistration");
  }
  args.push(...testArguments(settings));
  for (const [key, value] of Object.entries(settings.buildSettingOverrides)) {
    args.push(`${key}=${value}`);
  }
  return args;
}

function destinationArgument(destination: BuildDestination): string {
  if (destination.generic) {
    return destination.type === "SIMULATOR"
      ? "generic/platform=iOS Simulator"
      : "generic/platform=iOS";
  }
  return destination.type === "SIMULATOR"
    ? `platform=iOS Simulator,id=${destination.id}`
    : `platform=iOS,id=${destination.id}`;
}

function actionArgument(action: BuildAction): string {
  return {
    BUILD: "build",
    TEST: "test",
    ANALYZE: "analyze",
    ARCHIVE: "archive",
    BUILD_FOR_TESTING: "build-for-testing",
    TEST_WITHOUT_BUILDING: "test-without-building",
  }[action];
}

export function xcodeBuildArguments(input: BuildJobPayload): string[] {
  const resultBundle = join(input.artifactDirectory, "result.xcresult");
  const sourcePath = containedPath(input.folder, input.source.relativePath);
  const usesCapturedTestProducts = input.action === "TEST_WITHOUT_BUILDING";
  const args = [
    "xcodebuild",
    ...(usesCapturedTestProducts
      ? []
      : [
          ...sourceArguments(input.source, sourcePath),
          "-scheme",
          input.scheme,
          "-configuration",
          input.configuration,
        ]),
    "-destination",
    destinationArgument(input.destination),
    "-hideShellScriptEnvironment",
    "-resultBundlePath",
    resultBundle,
    ...(usesCapturedTestProducts
      ? testArguments(input.advancedSettings)
      : advancedArguments(input.advancedSettings)),
  ];
  if (input.action === "ARCHIVE") {
    args.push(
      "-archivePath",
      join(input.artifactDirectory, "archive.xcarchive"),
    );
  }
  if (input.action === "BUILD_FOR_TESTING") {
    args.push(
      "-testProductsPath",
      join(input.artifactDirectory, "test-products.xctestproducts"),
    );
  }
  if (
    input.action === "TEST_WITHOUT_BUILDING" &&
    input.advancedSettings.priorTestProductsPath
  ) {
    args.push(
      "-testProductsPath",
      input.advancedSettings.priorTestProductsPath,
    );
  }
  if (
    input.action === "TEST_WITHOUT_BUILDING" &&
    !input.advancedSettings.priorTestProductsPath &&
    input.advancedSettings.priorXctestrunPath
  ) {
    args.push("-xctestrun", input.advancedSettings.priorXctestrunPath);
  }
  args.push(actionArgument(input.action));
  return args;
}

export function xcodeBuildSettingsArguments(
  input: BuildJobPayload,
  folder = input.folder,
): string[] {
  return [
    "xcodebuild",
    ...sourceArguments(
      input.source,
      containedPath(folder, input.source.relativePath),
    ),
    "-scheme",
    input.scheme,
    "-configuration",
    input.configuration,
    "-destination",
    destinationArgument(input.destination),
    ...advancedArguments(input.advancedSettings),
    "-showBuildSettings",
    "-json",
  ];
}

function commandSummary(commandName: string, args: string[]): string {
  return [commandName, ...args]
    .map((value) =>
      /^[A-Za-z0-9_./:=,-]+$/.test(value) ? value : JSON.stringify(value),
    )
    .join(" ");
}

export function classifyFailure(output: string): string {
  if (
    /scheme .* is not currently configured|does not contain a scheme|scheme .* not found/i.test(
      output,
    )
  ) {
    return "MISSING_SCHEME";
  }
  if (
    /unable to find a destination|device.*(unavailable|disconnected)|destination.*not found/i.test(
      output,
    )
  ) {
    return "DESTINATION_UNAVAILABLE";
  }
  if (
    /provisioning profile|code sign|signing certificate|requires a development team/i.test(
      output,
    )
  ) {
    return "SIGNING_FAILED";
  }
  if (
    /package resolution|could not resolve package|failed fetching|Package\.resolved/i.test(
      output,
    )
  ) {
    return "PACKAGE_RESOLUTION_FAILED";
  }
  return "XCODEBUILD_FAILED";
}

type ScriptExecutionResult = {
  phase: "PRE_BUILD" | "POST_BUILD";
  position: number;
  status: string;
  exitCode: number | null;
  durationMs: number;
  causedBuildFailure: boolean;
  outputRelativePath: string;
  error: string | null;
};

async function runHook(options: {
  input: BuildJobPayload;
  folder: string;
  script: BuildJobPayload["scripts"][number];
  phase: "PRE_BUILD" | "POST_BUILD";
  source: string;
  contextPath: string;
  hookContext: Record<string, unknown>;
  logger: BuildLogger;
  signal: AbortSignal;
}): Promise<ScriptExecutionResult> {
  const phaseDirectory = options.phase === "PRE_BUILD" ? "pre" : "post";
  const directory = join(
    options.input.artifactDirectory,
    "hooks",
    phaseDirectory,
  );
  const prefix = `${String(options.script.position).padStart(3, "0")}-${options.script.id}`;
  const file = join(directory, `${prefix}.mjs`);
  const runner = join(directory, `${prefix}.runner.mjs`);
  const log = join(directory, `${prefix}.log`);
  const started = Date.now();
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, `${options.source}\n`, { mode: 0o600 });
    await writeFile(
      options.contextPath,
      `${JSON.stringify(options.hookContext, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      runner,
      `import { readFile } from "node:fs/promises";
const hookModule = await import(${JSON.stringify(`./${basename(file)}`)});
if (hookModule.default !== undefined && typeof hookModule.default !== "function") {
  throw new TypeError("The default build hook export must be a function");
}
if (typeof hookModule.default === "function") {
  const build = JSON.parse(await readFile(process.env.BUILD_CONTEXT_PATH, "utf8"));
  await hookModule.default(build);
}
`,
      { mode: 0o600 },
    );
    const result = await runLoggedCommand({
      command: process.execPath,
      args: [runner],
      cwd: options.folder,
      env: minimalEnvironment({
        BUILD_ID: options.input.buildId,
        BUILD_PHASE: options.phase,
        BUILD_CONTEXT_PATH: options.contextPath,
        BUILD_ARTIFACT_DIRECTORY: options.input.artifactDirectory,
      }),
      timeoutMs: options.script.timeoutSeconds * 1_000,
      signal: options.signal,
      logger: options.logger,
      phase: options.phase,
      scope: "BUILD",
      scopeId: options.input.buildId,
      additionalLogPath: log,
    });
    const failed = result.exitCode !== 0 || result.timedOut;
    return {
      phase: options.phase,
      position: options.script.position,
      status: result.cancelled
        ? "CANCELLED"
        : result.timedOut
          ? "TIMED_OUT"
          : failed
            ? "FAILED"
            : "SUCCEEDED",
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      causedBuildFailure:
        failed && options.script.failureBehavior === "FAIL_BUILD",
      outputRelativePath: relative(options.input.artifactDirectory, log),
      error: failed ? cleanError(result.output || "Build hook failed") : null,
    };
  } catch (hookError) {
    const error = cleanError(hookError);
    options.logger.emit(options.phase, "STDERR", error);
    return {
      phase: options.phase,
      position: options.script.position,
      status: options.signal.aborted ? "CANCELLED" : "FAILED",
      exitCode: null,
      durationMs: Date.now() - started,
      causedBuildFailure:
        !options.signal.aborted &&
        options.script.failureBehavior === "FAIL_BUILD",
      outputRelativePath: relative(options.input.artifactDirectory, log),
      error,
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathSize(path: string): Promise<number> {
  const information = await stat(path);
  if (information.isFile()) return information.size;
  if (!information.isDirectory()) return 0;
  let size = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    size += await pathSize(join(path, entry.name));
  }
  return size;
}

async function fileChecksum(path: string): Promise<string | null> {
  try {
    const information = await stat(path);
    if (!information.isFile() || information.size > 256 * 1024 * 1024)
      return null;
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return null;
  }
}

async function artifact(
  root: string,
  kind: string,
  path: string,
  metadata: Record<string, unknown> = {},
): Promise<Artifact> {
  return {
    kind,
    relativePath: relative(root, path).split(sep).join("/"),
    sizeBytes: await pathSize(path),
    checksum: await fileChecksum(path),
    metadata,
  };
}

type BuildSettingEntry = {
  target: string;
  buildSettings: Record<string, string>;
};

function parseBuildSettings(value: string): BuildSettingEntry[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((raw): BuildSettingEntry[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    if (!record.buildSettings || typeof record.buildSettings !== "object")
      return [];
    return [
      {
        target: typeof record.target === "string" ? record.target : "",
        buildSettings: Object.fromEntries(
          Object.entries(
            record.buildSettings as Record<string, unknown>,
          ).flatMap(([key, setting]) =>
            typeof setting === "string" ? [[key, setting]] : [],
          ),
        ),
      },
    ];
  });
}

async function findFiles(
  root: string,
  predicate: (name: string) => boolean,
  limit = 20,
): Promise<string[]> {
  const results: string[] = [];
  const queue = [root];
  while (queue.length && results.length < limit) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && predicate(entry.name)) results.push(path);
      if (results.length >= limit) break;
    }
  }
  return results;
}

async function captureArtifacts(
  input: BuildJobPayload,
  folder: string,
  signal: AbortSignal,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  const resultBundle = join(input.artifactDirectory, "result.xcresult");
  if (await pathExists(resultBundle)) {
    artifacts.push(
      await artifact(input.artifactDirectory, "RESULT_BUNDLE", resultBundle),
    );
  }
  const archivePath = join(input.artifactDirectory, "archive.xcarchive");
  if (await pathExists(archivePath)) {
    artifacts.push(
      await artifact(input.artifactDirectory, "ARCHIVE", archivePath),
    );
  }
  const settingsResult = await command(
    "xcrun",
    xcodeBuildSettingsArguments(input, folder),
    60_000,
    signal,
    folder,
    xcodeEnvironment(),
  );
  if (settingsResult.exitCode !== 0) return artifacts;
  const entries = parseBuildSettings(settingsResult.stdout);
  const apps = entries.filter((entry) => {
    const settings = entry.buildSettings;
    return (
      settings.WRAPPER_EXTENSION === "app" ||
      settings.FULL_PRODUCT_NAME?.endsWith(".app")
    );
  });
  if (apps.length === 1) {
    const settings = apps[0]!.buildSettings;
    const productName = settings.FULL_PRODUCT_NAME ?? settings.WRAPPER_NAME;
    const source =
      settings.TARGET_BUILD_DIR && productName
        ? join(settings.TARGET_BUILD_DIR, productName)
        : null;
    if (source && (await pathExists(source))) {
      const productDirectory = join(input.artifactDirectory, "products");
      const destination = join(productDirectory, basename(source));
      await mkdir(productDirectory, { recursive: true, mode: 0o700 });
      await rm(destination, { recursive: true, force: true });
      await cp(source, destination, {
        recursive: true,
        preserveTimestamps: true,
      });
      artifacts.push(
        await artifact(input.artifactDirectory, "RUNNABLE_APP", destination, {
          bundleIdentifier: settings.PRODUCT_BUNDLE_IDENTIFIER ?? null,
          target: apps[0]!.target,
          destinationType: input.destination.type,
        }),
      );
    }
  }
  if (input.action === "BUILD_FOR_TESTING") {
    const testDirectory = join(
      input.artifactDirectory,
      "test-products.xctestproducts",
    );
    if (await pathExists(testDirectory)) {
      artifacts.push(
        await artifact(input.artifactDirectory, "TEST_PRODUCTS", testDirectory),
      );
      for (const file of await findFiles(
        testDirectory,
        (name) => name.endsWith(".xctestrun"),
        20,
      )) {
        artifacts.push(
          await artifact(input.artifactDirectory, "XCTESTRUN", file, {
            testPlan: basename(file, ".xctestrun"),
          }),
        );
      }
    }
  }
  return artifacts;
}

export const runIosBuild: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  onLog,
  context,
) => {
  const input = parseBuildJobPayload(payload);
  const folder = await validateWorktree(
    input,
    Math.min(timeoutMs, 60_000),
    signal,
  );
  await validateSource(folder, input.source);
  if (input.action === "TEST_WITHOUT_BUILDING") {
    const testProductsPath = input.advancedSettings.priorTestProductsPath;
    const xctestrunPath = input.advancedSettings.priorXctestrunPath;
    if (testProductsPath) {
      if (
        !testProductsPath.endsWith(".xctestproducts") ||
        !(await pathExists(testProductsPath)) ||
        !(await stat(testProductsPath)).isDirectory()
      ) {
        throw new Error("The captured test-products artifact is unavailable");
      }
    } else if (
      !xctestrunPath?.endsWith(".xctestrun") ||
      !(await pathExists(xctestrunPath)) ||
      !(await stat(xctestrunPath)).isFile()
    ) {
      throw new Error("The captured .xctestrun artifact is unavailable");
    }
  }
  if (
    !isAbsolute(input.artifactDirectory) ||
    basename(input.artifactDirectory) !== input.buildId
  ) {
    throw new Error("Build artifact directory is invalid");
  }
  await mkdir(input.artifactDirectory, { recursive: true, mode: 0o700 });
  const rawLog = join(input.artifactDirectory, "build.log");
  const logger = new BuildLogger(input.buildId, context, rawLog, process.env);
  try {
    const scriptExecutions: ScriptExecutionResult[] = [];
    const contextPath = join(input.artifactDirectory, "context.json");
    const baseHookContext = {
      buildId: input.buildId,
      branch: input.branch ?? null,
      destination: input.destination,
      action: input.action,
      worktree: {
        id: input.worktreeId,
        folder,
        branch: input.branch ?? null,
        headSha: input.headSha,
      },
      source: input.source,
      scheme: input.scheme,
      configuration: input.configuration,
    };
    let buildResult: CommandResult | null = null;
    let errorCode: string | null = null;
    let error: string | null = null;
    let failBuild = false;
    try {
      try {
        await context?.reportBuildProgress?.({
          buildId: input.buildId,
          status: "PREPARING",
          startedAt: new Date().toISOString(),
        });
      } catch (progressError) {
        logger.emit("PREPARING", "SYSTEM", cleanError(progressError));
      }
      logger.emit("PREPARING", "SYSTEM", `Preparing build in ${folder}`);
      try {
        await onLog({
          sequence: 0,
          stream: "SYSTEM",
          message: "Preparing iOS build",
          createdAt: new Date().toISOString(),
        });
      } catch (progressError) {
        logger.emit("PREPARING", "SYSTEM", cleanError(progressError));
      }
      for (const script of [...input.scripts].sort(
        (a, b) => a.position - b.position,
      )) {
        if (!script.preBuildScript) continue;
        const execution = await runHook({
          input,
          folder,
          script,
          phase: "PRE_BUILD",
          source: script.preBuildScript,
          contextPath,
          hookContext: baseHookContext,
          logger,
          signal,
        });
        scriptExecutions.push(execution);
        if (execution.causedBuildFailure) {
          failBuild = true;
          errorCode = "SCRIPT_FAILED";
          error = execution.error;
          break;
        }
        if (signal.aborted) break;
      }
      if (!failBuild && !signal.aborted) {
        try {
          await context?.reportBuildProgress?.({
            buildId: input.buildId,
            status: "RUNNING",
          });
        } catch (progressError) {
          logger.emit("RUNNING", "SYSTEM", cleanError(progressError));
        }
        const args = xcodeBuildArguments(input);
        buildResult = await runLoggedCommand({
          command: "xcrun",
          args,
          cwd: folder,
          env: xcodeEnvironment(),
          timeoutMs,
          signal,
          logger,
          phase: "XCODEBUILD",
        });
        if (buildResult.exitCode !== 0 && !buildResult.cancelled) {
          failBuild = true;
          errorCode = buildResult.timedOut
            ? "TIMEOUT"
            : classifyFailure(buildResult.output);
          error = cleanError(buildResult.output || "xcodebuild failed");
        }
      }
    } finally {
      const postSignal = new AbortController().signal;
      for (const script of [...input.scripts].sort(
        (a, b) => b.position - a.position,
      )) {
        if (!script.postBuildScript) continue;
        try {
          const execution = await runHook({
            input,
            folder,
            script,
            phase: "POST_BUILD",
            source: script.postBuildScript,
            contextPath,
            hookContext: {
              ...baseHookContext,
              buildFolder: input.artifactDirectory,
              failed:
                failBuild ||
                (!signal.aborted &&
                  buildResult !== null &&
                  buildResult.exitCode !== 0),
              cancelled: signal.aborted || buildResult?.cancelled === true,
              errorCode,
              error,
            },
            logger,
            signal: postSignal,
          });
          scriptExecutions.push(execution);
          if (execution.causedBuildFailure && !signal.aborted) {
            failBuild = true;
            errorCode ??= "SCRIPT_FAILED";
            error ??= execution.error;
          }
        } catch (hookError) {
          logger.emit("POST_BUILD", "STDERR", cleanError(hookError));
          if (script.failureBehavior === "FAIL_BUILD" && !signal.aborted) {
            failBuild = true;
            errorCode ??= "SCRIPT_FAILED";
            error ??= cleanError(hookError);
          }
        }
      }
    }
    let artifacts: Artifact[] = [];
    if (!failBuild && !signal.aborted && buildResult?.exitCode === 0) {
      try {
        artifacts = await captureArtifacts(input, folder, signal);
      } catch (artifactError) {
        logger.emit("ARTIFACTS", "STDERR", cleanError(artifactError));
      }
    }
    await logger.close();
    if (await pathExists(rawLog)) {
      artifacts.unshift(
        await artifact(input.artifactDirectory, "RAW_LOG", rawLog),
      );
    }
    const cancelled = signal.aborted || buildResult?.cancelled === true;
    const timedOut = buildResult?.timedOut === true;
    const exitCode = cancelled
      ? null
      : failBuild || !buildResult
        ? 1
        : buildResult.exitCode;
    const args = xcodeBuildArguments(input);
    return {
      exitCode,
      signal: buildResult?.signal ?? null,
      timedOut,
      cancelled,
      errorCode,
      error,
      commandSummary: commandSummary("xcrun", args),
      artifacts,
      scriptExecutions,
    };
  } finally {
    await logger.close();
  }
};

export const deleteIosBuild: AgentJobHandler = async (
  payload,
  _timeoutMs,
  signal,
  onLog,
) => {
  const input = parseBuildDeletePayload(payload);
  if (signal.aborted) return { ...successfulProcess, cancelled: true };
  await rm(input.artifactDirectory, { recursive: true, force: true });
  await onLog({
    sequence: 0,
    stream: "SYSTEM",
    message: `Deleted build folder ${input.artifactDirectory}`,
    createdAt: new Date().toISOString(),
  });
  return successfulProcess;
};

export const downloadIosBuildArtifact: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  onLog,
  context,
) => {
  const input = parseBuildArtifactDownloadPayload(payload);
  if (!context?.uploadBuildArtifact) {
    throw new Error("This agent cannot upload build artifacts");
  }
  const root = await realpath(input.artifactDirectory);
  const target = await realpath(
    containedPath(root, input.artifactRelativePath),
  );
  const difference = relative(root, target);
  if (
    !difference ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("Build artifact resolves outside the build folder");
  }
  const information = await stat(target);
  let uploadPath = target;
  let filename = basename(target);
  let contentType = "application/octet-stream";
  let temporaryArchive: string | null = null;
  try {
    if (information.isDirectory()) {
      temporaryArchive = join(
        tmpdir(),
        `ade-build-artifact-${randomUUID()}.tar.gz`,
      );
      requireSuccess(
        await command(
          "tar",
          ["-czf", temporaryArchive, "-C", dirname(target), basename(target)],
          timeoutMs,
          signal,
        ),
        "Could not package the build artifact",
      );
      uploadPath = temporaryArchive;
      filename = `${filename}.tar.gz`;
      contentType = "application/gzip";
    } else if (!information.isFile()) {
      throw new Error("Build artifact is not downloadable");
    }
    await onLog({
      sequence: 0,
      stream: "SYSTEM",
      message: `Uploading build artifact ${filename}`,
      createdAt: new Date().toISOString(),
    });
    await context.uploadBuildArtifact({
      uploadId: input.uploadId,
      path: uploadPath,
      filename,
      contentType,
    });
    return successfulProcess;
  } finally {
    if (temporaryArchive) {
      await rm(temporaryArchive, { force: true });
    }
  }
};

async function runSimpleLogged(
  logger: BuildLogger,
  options: {
    args: string[];
    cwd: string;
    timeoutMs: number;
    signal: AbortSignal;
    phase: string;
    scopeId: string;
    logPath: string;
  },
) {
  return runLoggedCommand({
    command: "xcrun",
    args: options.args,
    cwd: options.cwd,
    env: xcodeEnvironment(),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    logger,
    phase: options.phase,
    scope: "DEPLOYMENT",
    scopeId: options.scopeId,
    additionalLogPath: options.logPath,
  });
}

export function simulatorAppArguments(destinationId: string): string[] {
  return ["-a", "Simulator", "--args", "-CurrentDeviceUDID", destinationId];
}

export const deployIosBuild: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = parseBuildDeploymentPayload(payload);
  const folder = await validateWorktree(
    input,
    Math.min(timeoutMs, 60_000),
    signal,
  );
  const appPath = containedPath(
    input.artifactDirectory,
    input.artifactRelativePath,
  );
  if (!(await pathExists(appPath)) || !appPath.endsWith(".app")) {
    throw new Error("Runnable app artifact is missing");
  }
  const deploymentsDirectory = join(input.artifactDirectory, "deployments");
  await mkdir(deploymentsDirectory, { recursive: true, mode: 0o700 });
  const logger = new BuildLogger(
    input.buildId,
    context,
    join(deploymentsDirectory, "deployments.log"),
    process.env,
  );
  try {
    const outcomes: Array<Record<string, unknown>> = [];
    for (const deployment of input.deployments) {
      const directory = join(
        input.artifactDirectory,
        "deployments",
        deployment.id,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const logPath = join(directory, "deployment.log");
      const started = Date.now();
      let failure: string | null = null;
      try {
        if (deployment.destination.type === "SIMULATOR") {
          if (deployment.destination.state !== "Booted") {
            const boot = await runSimpleLogged(logger, {
              args: ["simctl", "boot", deployment.destination.id],
              cwd: folder,
              timeoutMs,
              signal,
              phase: "SIMULATOR_BOOT",
              scopeId: deployment.id,
              logPath,
            });
            if (
              boot.exitCode !== 0 &&
              !/current state: Booted/i.test(boot.output)
            ) {
              failure = cleanError(boot.output || "Could not boot simulator");
            }
          }
          if (!failure) {
            const openSimulator = await runLoggedCommand({
              command: "/usr/bin/open",
              args: simulatorAppArguments(deployment.destination.id),
              cwd: folder,
              env: xcodeEnvironment(),
              timeoutMs,
              signal,
              logger,
              phase: "SIMULATOR_OPEN",
              scope: "DEPLOYMENT",
              scopeId: deployment.id,
              additionalLogPath: logPath,
            });
            if (openSimulator.exitCode !== 0) {
              failure = cleanError(
                openSimulator.output || "Could not open Simulator",
              );
            }
          }
          if (!failure) {
            const bootStatus = await runSimpleLogged(logger, {
              args: ["simctl", "bootstatus", deployment.destination.id, "-b"],
              cwd: folder,
              timeoutMs,
              signal,
              phase: "SIMULATOR_BOOT",
              scopeId: deployment.id,
              logPath,
            });
            if (bootStatus.exitCode !== 0)
              failure = cleanError(bootStatus.output);
          }
          if (!failure) {
            const install = await runSimpleLogged(logger, {
              args: ["simctl", "install", deployment.destination.id, appPath],
              cwd: folder,
              timeoutMs,
              signal,
              phase: "INSTALL",
              scopeId: deployment.id,
              logPath,
            });
            if (install.exitCode !== 0) failure = cleanError(install.output);
          }
          if (!failure) {
            const launch = await runSimpleLogged(logger, {
              args: [
                "simctl",
                "launch",
                deployment.destination.id,
                input.bundleIdentifier,
              ],
              cwd: folder,
              timeoutMs,
              signal,
              phase: "LAUNCH",
              scopeId: deployment.id,
              logPath,
            });
            if (launch.exitCode !== 0) failure = cleanError(launch.output);
          }
        } else {
          const verify = await runLoggedCommand({
            command: "/usr/bin/codesign",
            args: ["--verify", "--deep", "--strict", appPath],
            cwd: folder,
            env: xcodeEnvironment(),
            timeoutMs,
            signal,
            logger,
            phase: "SIGNATURE_VERIFY",
            scope: "DEPLOYMENT",
            scopeId: deployment.id,
            additionalLogPath: logPath,
          });
          if (verify.exitCode !== 0)
            failure = cleanError(verify.output || "App signature is invalid");
          if (!failure) {
            const install = await runSimpleLogged(logger, {
              args: [
                "devicectl",
                "device",
                "install",
                "app",
                "--device",
                deployment.destination.id,
                appPath,
              ],
              cwd: folder,
              timeoutMs,
              signal,
              phase: "INSTALL",
              scopeId: deployment.id,
              logPath,
            });
            if (install.exitCode !== 0) failure = cleanError(install.output);
          }
          if (!failure) {
            const launch = await runSimpleLogged(logger, {
              args: [
                "devicectl",
                "device",
                "process",
                "launch",
                "--device",
                deployment.destination.id,
                "--terminate-existing",
                input.bundleIdentifier,
              ],
              cwd: folder,
              timeoutMs,
              signal,
              phase: "LAUNCH",
              scopeId: deployment.id,
              logPath,
            });
            if (launch.exitCode !== 0) failure = cleanError(launch.output);
          }
        }
      } catch (deploymentError) {
        failure = cleanError(deploymentError);
        logger.emit(
          "DEPLOYMENT",
          "STDERR",
          failure,
          "DEPLOYMENT",
          deployment.id,
        );
      }
      outcomes.push({
        id: deployment.id,
        status: signal.aborted ? "CANCELLED" : failure ? "FAILED" : "SUCCEEDED",
        error: failure,
        durationMs: Date.now() - started,
        outputRelativePath: relative(input.artifactDirectory, logPath),
      });
      if (signal.aborted) break;
    }
    await logger.close();
    return {
      exitCode: outcomes.some((outcome) => outcome.status === "FAILED") ? 1 : 0,
      signal: null,
      timedOut: false,
      cancelled: signal.aborted,
      deployments: outcomes,
    };
  } finally {
    await logger.close();
  }
};

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "string") return `<string>${xml(value)}</string>`;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return `<dict>${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `<key>${xml(key)}</key>${plistValue(entry)}`)
      .join("")}</dict>`;
  }
  throw new Error("Unsupported export plist value");
}

function exportPlist(settings: BuildExportSettings): string {
  const method = {
    DEBUGGING: "debugging",
    RELEASE_TESTING: "release-testing",
    ENTERPRISE: "enterprise",
    APP_STORE_CONNECT: "app-store-connect",
  }[settings.method];
  const values: Record<string, unknown> = {
    destination: "export",
    method,
    signingStyle: settings.signingStyle.toLowerCase(),
    uploadSymbols: settings.uploadSymbols,
    manageAppVersionAndBuildNumber: settings.manageAppVersionAndBuildNumber,
    testFlightInternalTestingOnly: settings.testFlightInternalTestingOnly,
  };
  if (settings.teamId) values.teamID = settings.teamId;
  if (settings.signingCertificate)
    values.signingCertificate = settings.signingCertificate;
  if (Object.keys(settings.provisioningProfiles).length) {
    values.provisioningProfiles = settings.provisioningProfiles;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(values)}</plist>\n`;
}

export const exportIosArchive: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = parseBuildExportPayload(payload);
  const folder = await validateWorktree(
    input,
    Math.min(timeoutMs, 60_000),
    signal,
  );
  const archivePath = containedPath(
    input.artifactDirectory,
    input.archiveRelativePath,
  );
  if (!(await pathExists(archivePath)) || !archivePath.endsWith(".xcarchive")) {
    throw new Error("Archive artifact is missing");
  }
  const exportDirectory = join(
    input.artifactDirectory,
    "exports",
    input.exportId,
  );
  await mkdir(exportDirectory, { recursive: true, mode: 0o700 });
  const plistPath = join(exportDirectory, "ExportOptions.plist");
  const logPath = join(exportDirectory, "export.log");
  await writeFile(plistPath, exportPlist(input.settings), { mode: 0o600 });
  const logger = new BuildLogger(input.buildId, context, logPath, process.env);
  try {
    const result = await runLoggedCommand({
      command: "xcrun",
      args: [
        "xcodebuild",
        "-exportArchive",
        "-archivePath",
        archivePath,
        "-exportPath",
        exportDirectory,
        "-exportOptionsPlist",
        plistPath,
        "-hideShellScriptEnvironment",
      ],
      cwd: folder,
      env: xcodeEnvironment(),
      timeoutMs,
      signal,
      logger,
      phase: "EXPORT",
      scope: "EXPORT",
      scopeId: input.exportId,
    });
    await logger.close();
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputRelativePath: relative(input.artifactDirectory, exportDirectory),
      sizeBytes: result.exitCode === 0 ? await pathSize(exportDirectory) : null,
      error: result.exitCode === 0 ? null : cleanError(result.output),
    };
  } finally {
    await logger.close();
  }
};
