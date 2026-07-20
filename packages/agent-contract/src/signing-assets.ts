export const SIGNING_ASSETS_SCAN_JOB_KIND = "ios.signing.assets.scan";
export const SIGNING_PROFILE_READ_JOB_KIND = "ios.signing.profile.read";
export const SIGNING_PROFILE_INSTALL_JOB_KIND = "ios.signing.profile.install";
export const SIGNING_PROFILE_DELETE_JOB_KIND = "ios.signing.profile.delete";
export const SIGNING_IDENTITY_IMPORT_JOB_KIND = "ios.signing.identity.import";
export const SIGNING_IDENTITY_DELETE_JOB_KIND = "ios.signing.identity.delete";

export const SIGNING_ASSET_JOB_KINDS = [
  SIGNING_ASSETS_SCAN_JOB_KIND,
  SIGNING_PROFILE_READ_JOB_KIND,
  SIGNING_PROFILE_INSTALL_JOB_KIND,
  SIGNING_PROFILE_DELETE_JOB_KIND,
  SIGNING_IDENTITY_IMPORT_JOB_KIND,
  SIGNING_IDENTITY_DELETE_JOB_KIND,
] as const;

export type SigningProfileAssetSnapshot = {
  uuid: string;
  contentHash: string;
  name: string;
  profileType: "DEVELOPMENT" | "AD_HOC" | "ENTERPRISE" | "APP_STORE";
  bundleId: string;
  teamId: string | null;
  teamName: string | null;
  platforms: string[];
  deviceCount: number;
  deviceUdids: string[];
  certificateSha1s: string[];
  createdAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  xcodeManaged: boolean;
};

export type SigningCertificateAssetSnapshot = {
  sha1: string;
  sha256: string | null;
  name: string;
  teamId: string | null;
  certificateType: string | null;
  notBefore: string | null;
  expiresAt: string | null;
  expired: boolean;
  hasPrivateKey: boolean;
};

export type SigningAssetsScanResult = {
  profiles: SigningProfileAssetSnapshot[];
  certificates: SigningCertificateAssetSnapshot[];
  warnings: string[];
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : stringValue(value, name);
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry, index) => stringValue(entry, `${name}[${index}]`));
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function dateString(value: unknown, name: string): string | null {
  const text = nullableString(value, name);
  if (text !== null && !Number.isFinite(Date.parse(text))) {
    throw new Error(`${name} must be an ISO-8601 date`);
  }
  return text;
}

function exactKeys(value: JsonObject, allowed: string[], name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected ${name} field: ${unexpected}`);
}

export function signingScanPayload(value: unknown): Record<string, never> {
  const input = objectValue(value, "signing scan payload");
  exactKeys(input, [], "signing scan payload");
  return {};
}

export function signingProfileKeyPayload(value: unknown): { uuid: string } {
  const input = objectValue(value, "signing profile payload");
  exactKeys(input, ["uuid"], "signing profile payload");
  return { uuid: stringValue(input.uuid, "signing profile payload.uuid") };
}

export function signingProfileInstallPayload(value: unknown): {
  contentBase64: string;
} {
  const input = objectValue(value, "signing profile install payload");
  exactKeys(input, ["contentBase64"], "signing profile install payload");
  const contentBase64 = stringValue(
    input.contentBase64,
    "signing profile install payload.contentBase64",
  );
  if (contentBase64.length > 2 * 1024 * 1024) {
    throw new Error("Provisioning profile payload is too large");
  }
  return { contentBase64 };
}

export function signingIdentityImportPayload(value: unknown): {
  transferId: string;
  sha256: string;
} {
  const input = objectValue(value, "signing identity import payload");
  exactKeys(input, ["transferId", "sha256"], "signing identity import payload");
  const sha256 = stringValue(input.sha256, "signing identity import sha256");
  if (!/^[A-Fa-f0-9]{64}$/.test(sha256)) {
    throw new Error("Signing identity import SHA-256 is invalid");
  }
  return {
    transferId: stringValue(input.transferId, "signing identity transfer ID"),
    sha256: sha256.toUpperCase(),
  };
}

export function signingIdentityDeletePayload(value: unknown): { sha1: string } {
  const input = objectValue(value, "signing identity delete payload");
  exactKeys(input, ["sha1"], "signing identity delete payload");
  const sha1 = stringValue(input.sha1, "signing identity SHA-1");
  if (!/^[A-Fa-f0-9]{40}$/.test(sha1)) {
    throw new Error("Signing identity SHA-1 is invalid");
  }
  return { sha1: sha1.toUpperCase() };
}

export function parseSigningAssetsScanResult(
  value: unknown,
): SigningAssetsScanResult {
  const result = objectValue(value, "signing assets result");
  if (
    !Array.isArray(result.profiles) ||
    !Array.isArray(result.certificates) ||
    !Array.isArray(result.warnings)
  ) {
    throw new Error("Signing assets result arrays are invalid");
  }
  const profiles = result.profiles.map((raw, index) => {
    const item = objectValue(raw, `signing profiles[${index}]`);
    const profileType = stringValue(
      item.profileType,
      `signing profiles[${index}].profileType`,
    );
    if (
      !["DEVELOPMENT", "AD_HOC", "ENTERPRISE", "APP_STORE"].includes(
        profileType,
      )
    ) {
      throw new Error(`signing profiles[${index}].profileType is invalid`);
    }
    const deviceCount = item.deviceCount;
    if (
      typeof deviceCount !== "number" ||
      !Number.isInteger(deviceCount) ||
      deviceCount < 0
    ) {
      throw new Error(`signing profiles[${index}].deviceCount is invalid`);
    }
    return {
      uuid: stringValue(item.uuid, `signing profiles[${index}].uuid`),
      contentHash: stringValue(
        item.contentHash,
        `signing profiles[${index}].contentHash`,
      ),
      name: stringValue(item.name, `signing profiles[${index}].name`),
      profileType: profileType as SigningProfileAssetSnapshot["profileType"],
      bundleId: stringValue(
        item.bundleId,
        `signing profiles[${index}].bundleId`,
      ),
      teamId: nullableString(item.teamId, `signing profiles[${index}].teamId`),
      teamName: nullableString(
        item.teamName,
        `signing profiles[${index}].teamName`,
      ),
      platforms: stringArray(
        item.platforms,
        `signing profiles[${index}].platforms`,
      ),
      deviceCount,
      deviceUdids:
        item.deviceUdids === undefined
          ? []
          : stringArray(
              item.deviceUdids,
              `signing profiles[${index}].deviceUdids`,
            ),
      certificateSha1s: stringArray(
        item.certificateSha1s,
        `signing profiles[${index}].certificateSha1s`,
      ),
      createdAt: dateString(
        item.createdAt,
        `signing profiles[${index}].createdAt`,
      ),
      expiresAt: dateString(
        item.expiresAt,
        `signing profiles[${index}].expiresAt`,
      ),
      expired: booleanValue(item.expired, `signing profiles[${index}].expired`),
      xcodeManaged: booleanValue(
        item.xcodeManaged,
        `signing profiles[${index}].xcodeManaged`,
      ),
    };
  });
  const certificates = result.certificates.map((raw, index) => {
    const item = objectValue(raw, `signing certificates[${index}]`);
    return {
      sha1: stringValue(item.sha1, `signing certificates[${index}].sha1`),
      sha256: nullableString(
        item.sha256,
        `signing certificates[${index}].sha256`,
      ),
      name: stringValue(item.name, `signing certificates[${index}].name`),
      teamId: nullableString(
        item.teamId,
        `signing certificates[${index}].teamId`,
      ),
      certificateType: nullableString(
        item.certificateType,
        `signing certificates[${index}].certificateType`,
      ),
      notBefore: dateString(
        item.notBefore,
        `signing certificates[${index}].notBefore`,
      ),
      expiresAt: dateString(
        item.expiresAt,
        `signing certificates[${index}].expiresAt`,
      ),
      expired: booleanValue(
        item.expired,
        `signing certificates[${index}].expired`,
      ),
      hasPrivateKey: booleanValue(
        item.hasPrivateKey,
        `signing certificates[${index}].hasPrivateKey`,
      ),
    };
  });
  return {
    profiles,
    certificates,
    warnings: stringArray(result.warnings, "signing warnings"),
  };
}
