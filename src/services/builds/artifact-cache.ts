import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cancelArtifactTransfer,
  expectArtifactTransfer,
} from "./artifact-transfer";
import { getServerServices } from "@/services/server-services";

export type MaterializedArtifact = {
  path: string;
  filename: string;
  contentType: string;
  size: number;
  etag: string;
};

type Sidecar = {
  filename: string;
  contentType: string;
  size: number;
};

// Overridable so the cache can be pointed at a volume with room for large
// packages, rather than whatever the temporary directory happens to allow.
const CACHE_DIRECTORY =
  process.env.ARTIFACT_CACHE_DIRECTORY?.trim() ||
  join(tmpdir(), "ade-build-artifact-cache");
const MAX_CACHE_BYTES =
  Number(process.env.ARTIFACT_CACHE_MAX_BYTES) || 5 * 1024 ** 3;
const MAX_CACHE_AGE_MS = 6 * 60 * 60 * 1_000;

const globalCache = globalThis as typeof globalThis & {
  buildArtifactMaterializations?: Map<string, Promise<MaterializedArtifact>>;
};
const inFlight =
  globalCache.buildArtifactMaterializations ??
  (globalCache.buildArtifactMaterializations = new Map());

/**
 * Transfers are billed against wall-clock time on a link we do not control, so
 * the ceiling scales with the artifact: two minutes of overhead plus roughly a
 * second per megabyte, capped so a stalled agent cannot hold a request forever.
 */
function transferTimeout(sizeBytes: number | null): number {
  return Math.min(30 * 60_000, 120_000 + (sizeBytes ?? 0) / 1_000);
}

/**
 * Uses an atomic rename when possible. A configured cache volume can live on a
 * different filesystem from the upload receiver's temporary directory, in
 * which case the bytes are staged on the cache filesystem before the final
 * rename.
 */
async function moveIntoCache(source: string, destination: string) {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }

  const staging = `${destination}.${randomUUID()}.incoming`;
  try {
    await copyFile(source, staging);
    await rename(staging, destination);
    await rm(source, { force: true });
  } finally {
    await rm(staging, { force: true }).catch(() => {});
  }
}

function cacheKey(artifactId: string, identity: string): string {
  return createHash("sha1").update(`${artifactId}:${identity}`).digest("hex");
}

async function readSidecar(path: string): Promise<Sidecar | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const { filename, contentType, size } = parsed as Record<string, unknown>;
    if (
      typeof filename !== "string" ||
      typeof contentType !== "string" ||
      typeof size !== "number"
    ) {
      return null;
    }
    return { filename, contentType, size };
  } catch {
    return null;
  }
}

async function readCached(key: string): Promise<MaterializedArtifact | null> {
  const path = join(CACHE_DIRECTORY, key);
  const sidecar = await readSidecar(`${path}.json`);
  if (!sidecar) return null;
  try {
    const information = await stat(path);
    if (!information.isFile() || information.size !== sidecar.size) return null;
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return { path, etag: `"${key}"`, ...sidecar };
  } catch {
    return null;
  }
}

/**
 * Drops the least recently used entries once the cache exceeds its budget, and
 * anything past the maximum age. Entries are several hundred megabytes each, so
 * skipping this would fill the temporary directory within a handful of builds.
 *
 * `keep` is the entry the caller is about to serve. It is exempt so that an
 * artifact larger than the whole budget is still returned rather than deleted
 * out from under the response that just fetched it.
 */
async function prune(keep: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(CACHE_DIRECTORY);
  } catch {
    return;
  }
  const files: {
    path: string;
    size: number;
    mtimeMs: number;
    keep: boolean;
  }[] = [];
  const expired = Date.now() - MAX_CACHE_AGE_MS;
  for (const entry of entries) {
    if (entry.endsWith(".json")) continue;
    const path = join(CACHE_DIRECTORY, entry);
    try {
      const information = await stat(path);
      if (!information.isFile()) continue;
      // Cross-filesystem moves are copied into these staging files. Ignore an
      // active copy, but clean up one left behind by a terminated process.
      if (entry.endsWith(".incoming")) {
        if (information.mtimeMs < expired) {
          await rm(path, { force: true }).catch(() => {});
        }
        continue;
      }
      files.push({
        path,
        size: information.size,
        mtimeMs: information.mtimeMs,
        keep: entry === keep,
      });
    } catch {
      continue;
    }
  }
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  // The kept entry counts against the budget but is never a deletion candidate.
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (file.keep) continue;
    if (total <= MAX_CACHE_BYTES && file.mtimeMs >= expired) continue;
    await rm(file.path, { force: true }).catch(() => {});
    await rm(`${file.path}.json`, { force: true }).catch(() => {});
    total -= file.size;
  }
}

async function transfer(
  buildId: string,
  artifactId: string,
  key: string,
  sizeBytes: number | null,
): Promise<MaterializedArtifact> {
  const uploadId = randomUUID();
  const services = getServerServices();
  const build = await services.buildsService.getBuild(buildId);
  if (!build?.agentId) throw new Error("Build agent is unavailable");

  const timeoutMs = transferTimeout(sizeBytes);
  let receivedPath: string | null = null;
  try {
    const [received] = await Promise.all([
      expectArtifactTransfer(uploadId, build.agentId, timeoutMs),
      services.buildsService.prepareArtifactDownload(
        buildId,
        artifactId,
        uploadId,
        timeoutMs,
      ),
    ]);
    receivedPath = received.path;
    await mkdir(CACHE_DIRECTORY, { recursive: true, mode: 0o700 });
    const path = join(CACHE_DIRECTORY, key);
    await moveIntoCache(received.path, path);
    receivedPath = null;
    const size = (await stat(path)).size;
    const sidecar: Sidecar = {
      // The agent chooses the filename — it appends .tar.gz when it packages a
      // directory — so that decision has to survive into later cache hits.
      filename: received.filename,
      contentType: received.contentType,
      size,
    };
    // Written after the rename so a torn write cannot leave a valid-looking entry.
    await writeFile(`${path}.json`, JSON.stringify(sidecar), { mode: 0o600 });
    // Awaited so the budget actually holds by the time the response is served;
    // a directory scan is negligible next to the transfer that just finished.
    await prune(key).catch(() => {});
    return { path, etag: `"${key}"`, ...sidecar };
  } catch (error) {
    cancelArtifactTransfer(uploadId, error);
    if (receivedPath) {
      await rm(receivedPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Returns a local copy of a build artifact, fetching it from the agent only when
 * it is not already cached.
 *
 * The agent holds the only copy, and every fetch costs a full upload of the
 * whole file. iOS issues a probe plus several ranged requests per install, so
 * serving those directly from the relay would re-transfer the package several
 * times over. Caching first makes range requests answerable at all, and collapses
 * concurrent requests for the same artifact into one transfer.
 */
export async function materializeArtifact(
  buildId: string,
  artifactId: string,
): Promise<MaterializedArtifact> {
  const services = getServerServices();
  const artifact = await services.buildsService.artifactForInstall(
    buildId,
    artifactId,
  );
  if (!artifact) throw new Error("Build artifact not found");

  const key = cacheKey(artifactId, artifact.checksum ?? artifact.createdAt);
  const cached = await readCached(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const pending = transfer(
    buildId,
    artifactId,
    key,
    artifact.sizeBytes,
  ).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}
