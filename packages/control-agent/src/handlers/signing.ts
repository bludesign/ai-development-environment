import { createHash, randomUUID, X509Certificate } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import {
  parseBuildSigningInspectPayload,
  provisioningProfileType,
  type ArchiveBundle,
  type BuildSigningInspection,
  type SigningIdentity,
  type SigningProfile,
  type SigningTeam,
} from "@ai-development-environment/agent-contract/builds";
import { parsePlist } from "@ai-development-environment/agent-contract/plist";
import {
  signingIdentityDeletePayload,
  signingIdentityImportPayload,
  signingProfileInstallPayload,
  signingProfileKeyPayload,
  signingScanPayload,
  type SigningCertificateAssetSnapshot,
  type SigningProfileAssetSnapshot,
} from "@ai-development-environment/agent-contract/signing-assets";

import { captureCommand } from "../capture-command.js";

import type { AgentJobHandler } from "./index.js";

/**
 * Xcode 16 moved the profile library; older Xcode versions still use the
 * MobileDevice path, and both can be populated on the same machine.
 */
const PROFILE_DIRECTORIES = [
  join(
    homedir(),
    "Library",
    "Developer",
    "Xcode",
    "UserData",
    "Provisioning Profiles",
  ),
  join(homedir(), "Library", "MobileDevice", "Provisioning Profiles"),
];

const PROFILE_EXTENSIONS = [".mobileprovision", ".provisionprofile"];

type DecodedProfile = {
  path: string;
  content: Buffer;
  raw: Record<string, unknown>;
  uuid: string;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/** Decodes the CMS envelope a provisioning profile is wrapped in. */
async function decodeProfile(
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await captureCommand({
      command: "/usr/bin/security",
      args: ["cms", "-D", "-i", path],
      timeoutMs: Math.min(timeoutMs, 10_000),
      signal,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) return null;
    const parsed = parsePlist(result.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toProfile(
  uuid: string,
  raw: Record<string, unknown>,
  now: number,
): SigningProfile | null {
  const name = text(raw.Name);
  if (!name) return null;
  const entitlements =
    raw.Entitlements && typeof raw.Entitlements === "object"
      ? (raw.Entitlements as Record<string, unknown>)
      : {};
  const applicationIdentifier = text(entitlements["application-identifier"]);
  const teamId =
    stringList(raw.TeamIdentifier)[0] ??
    text(entitlements["com.apple.developer.team-identifier"]);
  // The application identifier is prefixed with the team, which is not part of
  // the bundle identifier Xcode matches against.
  const bundleId = applicationIdentifier
    ? applicationIdentifier.replace(/^[A-Z0-9]+\./, "")
    : "*";
  const expiresAt = text(raw.ExpirationDate);
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return {
    uuid,
    name,
    teamId: teamId ?? null,
    teamName: text(raw.TeamName),
    bundleId,
    type: provisioningProfileType({
      getTaskAllow: entitlements["get-task-allow"] === true,
      hasProvisionedDevices: stringList(raw.ProvisionedDevices).length > 0,
      provisionsAllDevices: raw.ProvisionsAllDevices === true,
    }),
    platforms: stringList(raw.Platform),
    expiresAt,
    expired: Number.isFinite(expiry) ? expiry < now : false,
    xcodeManaged: raw.IsXcodeManaged === true,
    certificateSha1s: certificateFingerprints(raw.DeveloperCertificates),
  };
}

/**
 * The fingerprints `security find-identity` prints are the SHA-1 of each
 * certificate's DER encoding, which is exactly what a profile stores.
 */
export function certificateFingerprints(value: unknown): string[] {
  return stringList(value).flatMap((encoded) => {
    try {
      // The parser preserves the base64 payload verbatim, newlines included.
      const der = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
      if (!der.length) return [];
      return [createHash("sha1").update(der).digest("hex").toUpperCase()];
    } catch {
      return [];
    }
  });
}

async function readProfiles(
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SigningProfile[]> {
  const profiles = new Map<string, SigningProfile>();
  const now = Date.now();
  for (const directory of PROFILE_DIRECTORIES) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!PROFILE_EXTENSIONS.some((suffix) => entry.endsWith(suffix)))
        continue;
      signal.throwIfAborted();
      const raw = await decodeProfile(
        join(directory, entry),
        timeoutMs,
        signal,
      );
      if (!raw) continue;
      // Prefer the UUID recorded inside the profile; the filename usually
      // matches it but is not guaranteed to.
      const uuid = text(raw.UUID) ?? basename(entry).replace(/\.[^.]+$/, "");
      const profile = toProfile(uuid, raw, now);
      if (profile && !profiles.has(profile.uuid)) {
        profiles.set(profile.uuid, profile);
      }
    }
  }
  return dedupeProfiles([...profiles.values()]).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function decodedProfiles(
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DecodedProfile[]> {
  const profiles: DecodedProfile[] = [];
  for (const directory of PROFILE_DIRECTORIES) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!PROFILE_EXTENSIONS.some((suffix) => entry.endsWith(suffix))) {
        continue;
      }
      signal.throwIfAborted();
      const path = join(directory, entry);
      const raw = await decodeProfile(path, timeoutMs, signal);
      if (!raw) continue;
      let content: Buffer;
      try {
        content = await readFile(path);
      } catch {
        continue;
      }
      profiles.push({
        path,
        content,
        raw,
        uuid: text(raw.UUID) ?? basename(entry).replace(/\.[^.]+$/, ""),
      });
    }
  }
  return profiles;
}

function profileAsset(
  decoded: DecodedProfile,
  now: number,
): SigningProfileAssetSnapshot | null {
  const profile = toProfile(decoded.uuid, decoded.raw, now);
  if (!profile) return null;
  const createdAt = text(decoded.raw.CreationDate);
  return {
    uuid: profile.uuid,
    contentHash: createHash("sha256")
      .update(decoded.content)
      .digest("hex")
      .toUpperCase(),
    name: profile.name,
    profileType: profile.type,
    bundleId: profile.bundleId,
    teamId: profile.teamId,
    teamName: profile.teamName,
    platforms: profile.platforms,
    deviceCount: stringList(decoded.raw.ProvisionedDevices).length,
    deviceUdids: stringList(decoded.raw.ProvisionedDevices),
    certificateSha1s: profile.certificateSha1s,
    createdAt,
    expiresAt: profile.expiresAt,
    expired: profile.expired,
    xcodeManaged: profile.xcodeManaged,
  };
}

/**
 * Collapses profiles that are the same to a caller.
 *
 * Re-downloading a profile leaves several copies with identical names and
 * expiry but fresh UUIDs. They differ only in an identifier nobody recognises,
 * so offering all of them makes the choice harder rather than more complete.
 * Only entries matching on every selection-relevant attribute, including their
 * accepted signing certificates, are merged, keeping the one that expires last.
 */
export function dedupeProfiles(profiles: SigningProfile[]): SigningProfile[] {
  const best = new Map<string, SigningProfile>();
  for (const profile of profiles) {
    const key = [
      profile.name,
      profile.type,
      profile.bundleId,
      profile.teamId ?? "",
      [...profile.platforms].sort().join(","),
      [...profile.certificateSha1s].sort().join(","),
    ].join("\0");
    const existing = best.get(key);
    if (
      !existing ||
      (profile.expiresAt ?? "") > (existing.expiresAt ?? "") ||
      // Stable tie-break so repeated inspections return the same profile.
      (profile.expiresAt === existing.expiresAt && profile.uuid < existing.uuid)
    ) {
      best.set(key, profile);
    }
  }
  return [...best.values()];
}

const IDENTITY_PATTERN = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/i;

async function readIdentities(
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SigningIdentity[]> {
  try {
    const result = await captureCommand({
      command: "/usr/bin/security",
      args: ["find-identity", "-v", "-p", "codesigning"],
      timeoutMs: Math.min(timeoutMs, 10_000),
      signal,
    });
    if (result.exitCode !== 0) return [];
    const identities = new Map<string, SigningIdentity>();
    for (const line of result.stdout.split("\n")) {
      const match = IDENTITY_PATTERN.exec(line);
      if (!match) continue;
      const [, sha1, name] = match as unknown as [string, string, string];
      // Certificate common names end with the team identifier in parentheses.
      const team = /\(([A-Z0-9]{10})\)\s*$/.exec(name);
      identities.set(sha1, { sha1, name, teamId: team?.[1] ?? null });
    }
    return [...identities.values()];
  } catch {
    return [];
  }
}

function commonName(certificate: X509Certificate): string {
  return (
    certificate.subject
      .split(/\n|,\s*/)
      .find((part) => part.startsWith("CN="))
      ?.slice(3) ?? certificate.subject
  );
}

function certificateType(name: string): string | null {
  const known = [
    "Apple Development",
    "Apple Distribution",
    "iPhone Developer",
    "iPhone Distribution",
    "iOS Developer",
    "iOS Distribution",
    "Mac Developer",
    "Mac App Distribution",
    "Developer ID Application",
    "Developer ID Installer",
  ];
  return known.find((prefix) => name.startsWith(prefix)) ?? null;
}

function pemCertificates(value: string): string[] {
  return (
    value.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? []
  );
}

async function readCertificates(
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SigningCertificateAssetSnapshot[]> {
  const [certificateResult, identities] = await Promise.all([
    captureCommand({
      command: "/usr/bin/security",
      args: ["find-certificate", "-a", "-p"],
      timeoutMs: Math.min(timeoutMs, 20_000),
      signal,
    }),
    readIdentities(timeoutMs, signal),
  ]);
  if (certificateResult.exitCode !== 0) return [];
  const identityHashes = new Set(
    identities.map((identity) => identity.sha1.toUpperCase()),
  );
  const assets = new Map<string, SigningCertificateAssetSnapshot>();
  for (const pem of pemCertificates(certificateResult.stdout)) {
    try {
      const certificate = new X509Certificate(pem);
      const name = commonName(certificate);
      const type = certificateType(name);
      if (!type) continue;
      const sha1 = certificate.fingerprint.replaceAll(":", "").toUpperCase();
      const expiresAt = new Date(certificate.validTo);
      const team = /\(([A-Z0-9]{10})\)\s*$/.exec(name);
      assets.set(sha1, {
        sha1,
        sha256: certificate.fingerprint256.replaceAll(":", "").toUpperCase(),
        name,
        teamId: team?.[1] ?? null,
        certificateType: type,
        notBefore: new Date(certificate.validFrom).toISOString(),
        expiresAt: expiresAt.toISOString(),
        expired: expiresAt.getTime() < Date.now(),
        hasPrivateKey: identityHashes.has(sha1),
      });
    } catch {
      continue;
    }
  }
  return [...assets.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * Collects the bundles inside an archive that need their own profile.
 *
 * Only apps and app extensions are signed with a profile; the resource bundles
 * that Swift packages emit sit alongside them and must not be offered.
 */
async function readArchiveBundles(
  archivePath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ArchiveBundle[]> {
  const products = join(archivePath, "Products");
  const bundles: ArchiveBundle[] = [];
  const queue = [products];
  while (queue.length) {
    signal.throwIfAborted();
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const path = join(current, entry.name);
      const signable = /\.(app|appex)$/.test(entry.name);
      if (!signable) {
        // Descend only through plain directories; never into other bundles.
        if (!/\.[A-Za-z0-9]+$/.test(entry.name)) queue.push(path);
        continue;
      }
      const bundleId = await bundleIdentifier(path, timeoutMs, signal);
      if (bundleId) {
        bundles.push({
          bundleId,
          name: basename(entry.name).replace(/\.(app|appex)$/, ""),
          relativePath: relative(archivePath, path).split(sep).join("/"),
          ...(await embeddedProfile(path, timeoutMs, signal)),
        });
      }
      // Nested apps and extensions each need their own profile.
      queue.push(path);
    }
  }
  return bundles.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function bundleIdentifier(
  bundlePath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const result = await captureCommand({
      command: "/usr/bin/plutil",
      args: [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
        join(bundlePath, "Info.plist"),
      ],
      timeoutMs: Math.min(timeoutMs, 5_000),
      signal,
    });
    const value = result.stdout.trim();
    return result.exitCode === 0 && value ? value : null;
  } catch {
    return null;
  }
}

async function embeddedProfile(
  bundlePath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{
  embeddedProfileUuid: string | null;
  embeddedProfileName: string | null;
}> {
  for (const name of [
    "embedded.mobileprovision",
    "embedded.provisionprofile",
  ]) {
    const path = join(bundlePath, name);
    try {
      await stat(path);
    } catch {
      continue;
    }
    const raw = await decodeProfile(path, timeoutMs, signal);
    if (raw) {
      return {
        embeddedProfileUuid: text(raw.UUID),
        embeddedProfileName: text(raw.Name),
      };
    }
  }
  return { embeddedProfileUuid: null, embeddedProfileName: null };
}

function teamsFrom(
  profiles: SigningProfile[],
  identities: SigningIdentity[],
): SigningTeam[] {
  const teams = new Map<string, string>();
  for (const profile of profiles) {
    if (!profile.teamId) continue;
    const existing = teams.get(profile.teamId);
    // Profiles carry a human readable team name; identities usually do too, but
    // the profile is the more reliable source.
    if (!existing && profile.teamName)
      teams.set(profile.teamId, profile.teamName);
    else if (!existing) teams.set(profile.teamId, profile.teamId);
  }
  for (const identity of identities) {
    if (!identity.teamId || teams.has(identity.teamId)) continue;
    const name = /^[^:]+:\s*(.+?)\s*\([A-Z0-9]{10}\)\s*$/.exec(identity.name);
    teams.set(identity.teamId, name?.[1] ?? identity.teamId);
  }
  return [...teams.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function inspectSigningAssets(
  archivePath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BuildSigningInspection> {
  const [profiles, identities, bundles] = await Promise.all([
    readProfiles(timeoutMs, signal),
    readIdentities(timeoutMs, signal),
    readArchiveBundles(archivePath, timeoutMs, signal),
  ]);
  return {
    teams: teamsFrom(profiles, identities),
    identities,
    profiles,
    bundles,
  };
}

export const inspectIosSigning: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = parseBuildSigningInspectPayload(payload);
  const archivePath = join(input.artifactDirectory, input.archiveRelativePath);
  const inspection = await inspectSigningAssets(archivePath, timeoutMs, signal);
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    ...inspection,
  };
};

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

export const scanSigningAssets: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  signingScanPayload(payload);
  const warnings: string[] = [];
  const [decoded, certificates] = await Promise.all([
    decodedProfiles(timeoutMs, signal).catch((error) => {
      warnings.push(error instanceof Error ? error.message : String(error));
      return [];
    }),
    readCertificates(timeoutMs, signal).catch((error) => {
      warnings.push(error instanceof Error ? error.message : String(error));
      return [];
    }),
  ]);
  const byUuid = new Map<string, SigningProfileAssetSnapshot>();
  for (const profile of decoded) {
    const asset = profileAsset(profile, Date.now());
    if (!asset) continue;
    const existing = byUuid.get(asset.uuid);
    if (!existing || (asset.expiresAt ?? "") > (existing.expiresAt ?? "")) {
      byUuid.set(asset.uuid, asset);
    }
  }
  return {
    ...successfulProcess,
    profiles: [...byUuid.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    certificates,
    warnings,
  };
};

async function findDecodedProfile(
  uuid: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DecodedProfile> {
  const profile = (await decodedProfiles(timeoutMs, signal)).find(
    (entry) => entry.uuid === uuid,
  );
  if (!profile) throw new Error("Provisioning profile is no longer installed");
  return profile;
}

export const readSigningProfile: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const { uuid } = signingProfileKeyPayload(payload);
  const profile = await findDecodedProfile(uuid, timeoutMs, signal);
  return {
    ...successfulProcess,
    uuid,
    contentBase64: profile.content.toString("base64"),
    sha256: createHash("sha256")
      .update(profile.content)
      .digest("hex")
      .toUpperCase(),
  };
};

export const installSigningProfile: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const { contentBase64 } = signingProfileInstallPayload(payload);
  const content = Buffer.from(contentBase64, "base64");
  if (!content.length) throw new Error("Provisioning profile is empty");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ade-profile-"));
  const temporaryPath = join(temporaryRoot, `${randomUUID()}.mobileprovision`);
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    const raw = await decodeProfile(temporaryPath, timeoutMs, signal);
    if (!raw) throw new Error("Provisioning profile is invalid or unsigned");
    const uuid = text(raw.UUID);
    if (!uuid) throw new Error("Provisioning profile UUID is missing");
    const directory = PROFILE_DIRECTORIES[0]!;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = join(directory, `${uuid}.mobileprovision`);
    await writeFile(destination, content, { mode: 0o600 });
    return { ...successfulProcess, uuid };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

export const deleteSigningProfile: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const { uuid } = signingProfileKeyPayload(payload);
  const matches = (await decodedProfiles(timeoutMs, signal)).filter(
    (entry) => entry.uuid === uuid,
  );
  for (const profile of matches) {
    signal.throwIfAborted();
    await rm(profile.path, { force: false });
  }
  return { ...successfulProcess, uuid, deleted: matches.length };
};

export const importSigningIdentity: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = signingIdentityImportPayload(payload);
  if (!context?.claimSigningSecretTransfer) {
    throw new Error("This agent cannot claim signing secret transfers");
  }
  const secret = await context.claimSigningSecretTransfer(input.transferId);
  const p12 = Buffer.from(secret.p12Base64, "base64");
  const hash = createHash("sha256").update(p12).digest("hex").toUpperCase();
  if (hash !== input.sha256)
    throw new Error("Signing identity transfer changed");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ade-identity-"));
  const path = join(temporaryRoot, "identity.p12");
  try {
    await writeFile(path, p12, { mode: 0o600 });
    const result = await captureCommand({
      command: "/usr/bin/security",
      args: [
        "import",
        path,
        "-P",
        secret.passphrase,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
      ],
      timeoutMs: Math.min(timeoutMs, 60_000),
      signal,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || "Could not import signing identity",
      );
    }
    return { ...successfulProcess, sha256: input.sha256 };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

export const deleteSigningIdentity: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const { sha1 } = signingIdentityDeletePayload(payload);
  const result = await captureCommand({
    command: "/usr/bin/security",
    args: ["delete-identity", "-Z", sha1],
    timeoutMs: Math.min(timeoutMs, 30_000),
    signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || "Could not delete signing identity",
    );
  }
  return { ...successfulProcess, sha1 };
};
