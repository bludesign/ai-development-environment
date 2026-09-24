import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATOS_BATCH_SIZE,
  atosArguments,
  parseAtosOutput,
  parseCrashSymbolicationPayload,
  type CrashSymbolicationDsym,
  type CrashSymbolicationLookupResult,
} from "@ai-development-environment/agent-contract/crashes";

import { captureCommand } from "../capture-command.js";
import type { ProcessLog } from "../process-runner.js";
import type { AgentJobHandler, AgentJobHandlerContext } from "./index.js";

/** Most disk the DWARF cache may use before the oldest files are evicted. */
const CACHE_LIMIT_BYTES = 10 * 1024 ** 3;
/** atos output for 500 addresses with deep inlining stays well under this. */
const ATOS_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

/**
 * Where downloaded DWARF files are kept between jobs, keyed by checksum so the
 * development and installed agents can share it safely.
 */
export function dsymCacheDirectory(): string {
  if (process.env.CONTROL_AGENT_DSYM_CACHE) {
    return process.env.CONTROL_AGENT_DSYM_CACHE;
  }
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "control-agent", "dsym-cache")
    : join(homedir(), ".cache", "control-agent", "dsym-cache");
}

async function log(
  onLog: (log: ProcessLog) => Promise<void>,
  sequence: number,
  message: string,
  stream: ProcessLog["stream"] = "SYSTEM",
) {
  await onLog({
    sequence,
    stream,
    message,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Returns the cached DWARF file, downloading it first when this agent has not
 * seen that checksum. Downloads land in a temporary name and are renamed into
 * place only after the checksum matched.
 */
async function cachedDwarf(
  dsym: CrashSymbolicationDsym,
  cache: string,
  download: NonNullable<AgentJobHandlerContext["downloadDsymDwarf"]>,
  signal: AbortSignal,
): Promise<{ path: string; downloaded: boolean }> {
  const folder = join(cache, dsym.sha256);
  const path = join(folder, dsym.binaryName);
  try {
    const existing = await stat(path);
    if (existing.size === dsym.sizeBytes) {
      const now = new Date();
      await utimes(folder, now, now).catch(() => undefined);
      return { path, downloaded: false };
    }
  } catch {
    // Not cached yet.
  }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const partial = join(folder, `.${dsym.binaryName}.${randomUUID()}.partial`);
  try {
    await download({
      downloadPath: dsym.downloadPath,
      path: partial,
      sizeBytes: dsym.sizeBytes,
      sha256: dsym.sha256,
      signal,
    });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return { path, downloaded: true };
}

/** Evicts the least recently used DWARF files until the cache fits its limit. */
export async function trimDsymCache(
  cache: string,
  keep: ReadonlySet<string>,
  limit = CACHE_LIMIT_BYTES,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(cache);
  } catch {
    return;
  }
  const folders: { name: string; size: number; used: number }[] = [];
  for (const name of entries) {
    const folder = join(cache, name);
    try {
      const information = await stat(folder);
      if (!information.isDirectory()) continue;
      let size = 0;
      for (const file of await readdir(folder)) {
        size += (await stat(join(folder, file))).size;
      }
      folders.push({ name, size, used: information.mtimeMs });
    } catch {
      // Removed by a concurrent job.
    }
  }
  let total = folders.reduce((sum, folder) => sum + folder.size, 0);
  for (const folder of folders.sort((left, right) => left.used - right.used)) {
    if (total <= limit) break;
    if (keep.has(folder.name)) continue;
    await rm(join(cache, folder.name), { recursive: true, force: true });
    total -= folder.size;
  }
}

async function xcodeVersion(signal: AbortSignal): Promise<string | null> {
  const result = await captureCommand({
    command: "xcrun",
    args: ["xcodebuild", "-version"],
    timeoutMs: 30_000,
    signal,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return result.stdout.trim().split(/\r?\n/).join(" ") || null;
}

/**
 * Names crash frames with `atos`. The control plane already worked out which
 * offsets of which images need names and which dSYM covers each image; this
 * downloads those DWARF files and asks `atos`, one batch per image.
 */
export const symbolicateCrash: AgentJobHandler = async (
  payloadValue,
  timeoutMs,
  signal,
  onLog,
  context,
) => {
  const payload = parseCrashSymbolicationPayload(payloadValue);
  if (!context?.downloadDsymDwarf) {
    throw new Error("This agent cannot download dSYMs");
  }
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const cache = dsymCacheDirectory();
  let sequence = 0;

  const dwarfPaths = new Map<string, string>();
  const downloadErrors = new Map<string, string>();
  for (const dsym of payload.dsyms) {
    if (signal.aborted) return { ...successfulProcess, cancelled: true };
    try {
      const { path, downloaded } = await cachedDwarf(
        dsym,
        cache,
        context.downloadDsymDwarf,
        signal,
      );
      dwarfPaths.set(dsym.dsymId, path);
      await log(
        onLog,
        sequence++,
        `${downloaded ? "Downloaded" : "Using cached"} ${dsym.binaryName} (${dsym.sha256.slice(0, 12)})`,
      );
    } catch (error) {
      if (signal.aborted) return { ...successfulProcess, cancelled: true };
      const message = error instanceof Error ? error.message : String(error);
      downloadErrors.set(dsym.dsymId, message);
      await log(
        onLog,
        sequence++,
        `Could not download ${dsym.binaryName}: ${message}`,
        "STDERR",
      );
    }
  }

  const workFolder = join(tmpdir(), `control-agent-atos-${randomUUID()}`);
  await mkdir(workFolder, { recursive: true, mode: 0o700 });
  const lookups: CrashSymbolicationLookupResult[] = [];
  try {
    for (const lookup of payload.lookups) {
      const dwarfPath = dwarfPaths.get(lookup.dsymId);
      const result: CrashSymbolicationLookupResult = {
        dsymId: lookup.dsymId,
        uuid: lookup.uuid,
        results: [],
        error: dwarfPath
          ? null
          : (downloadErrors.get(lookup.dsymId) ?? "The dSYM is unavailable"),
      };
      lookups.push(result);
      if (!dwarfPath) continue;
      for (
        let start = 0;
        start < lookup.offsets.length;
        start += ATOS_BATCH_SIZE
      ) {
        const batch = lookup.offsets.slice(start, start + ATOS_BATCH_SIZE);
        const offsetsFile = join(workFolder, `${lookup.uuid}-${start}.txt`);
        await writeFile(offsetsFile, `${batch.join("\n")}\n`, { mode: 0o600 });
        const run = await captureCommand({
          command: "xcrun",
          args: atosArguments({ arch: lookup.arch, dwarfPath, offsetsFile }),
          timeoutMs: remaining(),
          signal,
          maxOutputBytes: ATOS_OUTPUT_LIMIT_BYTES,
        });
        if (run.cancelled || run.timedOut) {
          return {
            exitCode: run.exitCode,
            signal: run.signal,
            timedOut: run.timedOut,
            cancelled: run.cancelled,
          };
        }
        if (run.exitCode !== 0) {
          result.error =
            run.stderr.trim().slice(0, 1_000) ||
            `atos exited with code ${run.exitCode}`;
          break;
        }
        if (run.outputTruncated) {
          result.error = "atos printed more output than the agent keeps";
          break;
        }
        try {
          result.results.push(...parseAtosOutput(run.stdout, batch));
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error);
          break;
        }
      }
      const named = result.results.filter((entry) => entry.frames.length);
      await log(
        onLog,
        sequence++,
        `${lookup.uuid} (${lookup.arch}): named ${named.length} of ${lookup.offsets.length} addresses${result.error ? `; ${result.error}` : ""}`,
        result.error ? "STDERR" : "SYSTEM",
      );
    }
  } finally {
    await rm(workFolder, { recursive: true, force: true });
  }

  await trimDsymCache(
    cache,
    new Set(payload.dsyms.map((dsym) => dsym.sha256)),
  ).catch(() => undefined);

  return {
    ...successfulProcess,
    lookups,
    xcodeVersion: await xcodeVersion(signal),
  };
};
