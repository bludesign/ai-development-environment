import type { IosDeviceFirmware, IosFirmwareVersion } from "./types";

const IPSW_API = "https://api.ipsw.me/v4/device";
const DEVICE_IDENTIFIER_PATTERN = /^[A-Za-z]+\d+,\d+$/;
const MAX_FIRMWARES = 1_000;

type FetchLike = typeof fetch;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`IPSW.me returned an invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`IPSW.me returned an invalid ${name}`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new Error(`IPSW.me returned an invalid ${name}`);
  }
  return result;
}

function firmware(value: unknown, identifier: string): IosFirmwareVersion {
  const entry = object(value, "firmware entry");
  if (string(entry.identifier, "firmware identifier", 50) !== identifier) {
    throw new Error("IPSW.me returned firmware for a different device");
  }
  const fileSize = entry.filesize;
  if (
    typeof fileSize !== "number" ||
    !Number.isSafeInteger(fileSize) ||
    fileSize < 0
  ) {
    throw new Error("IPSW.me returned an invalid firmware size");
  }
  const downloadUrl = string(entry.url, "firmware URL", 2_048);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(downloadUrl);
  } catch {
    throw new Error("IPSW.me returned an invalid firmware URL");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error("IPSW.me returned an insecure firmware URL");
  }
  const releaseDate = string(entry.releasedate, "release date", 100);
  const parsedReleaseDate = new Date(releaseDate);
  if (Number.isNaN(parsedReleaseDate.getTime())) {
    throw new Error("IPSW.me returned an invalid release date");
  }
  if (typeof entry.signed !== "boolean") {
    throw new Error("IPSW.me returned an invalid signing status");
  }
  return {
    version: string(entry.version, "firmware version", 50),
    buildId: string(entry.buildid, "firmware build", 50),
    fileSize,
    url: parsedUrl.toString(),
    releaseDate: parsedReleaseDate.toISOString(),
    signed: entry.signed,
  };
}

export function parseIpswDevice(
  value: unknown,
  expectedIdentifier: string,
): IosDeviceFirmware {
  const response = object(value, "device response");
  const identifier = string(response.identifier, "device identifier", 50);
  if (identifier !== expectedIdentifier) {
    throw new Error("IPSW.me returned a different device");
  }
  if (!Array.isArray(response.firmwares)) {
    throw new Error("IPSW.me returned an invalid firmware list");
  }
  return {
    name: string(response.name, "device name", 100),
    identifier,
    firmwares: response.firmwares
      .slice(0, MAX_FIRMWARES)
      .map((entry) => firmware(entry, identifier))
      .sort(
        (first, second) =>
          Date.parse(second.releaseDate) - Date.parse(first.releaseDate),
      ),
  };
}

export async function fetchIpswDevice(
  identifier: string,
  fetcher: FetchLike = fetch,
): Promise<IosDeviceFirmware> {
  if (!DEVICE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error("Device product identifier is invalid");
  }
  let response: Response;
  try {
    response = await fetcher(`${IPSW_API}/${encodeURIComponent(identifier)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Could not connect to IPSW.me");
  }
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "IPSW.me does not recognize this device model"
        : `IPSW.me returned HTTP ${response.status}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("IPSW.me returned invalid JSON");
  }
  return parseIpswDevice(body, identifier);
}
