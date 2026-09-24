import { CrashParseError, type NormalizedCrash } from "../types";
import { looksLikeAppleTextCrash, parseAppleTextCrash } from "./apple-text";
import { parseIps, splitIps } from "./ips";
import { isMetricKitPayload, parseMetricKit } from "./metrickit";

export { isAppImage } from "./common";
export { parseAppleTextCrash } from "./apple-text";
export { parseIps } from "./ips";
export { parseMetricKit } from "./metrickit";

/**
 * Works out which of the three formats a file is and parses it. The content
 * decides, not the file name: apps post MetricKit JSON without one, and an
 * `.ips` saved from Mail can arrive renamed to `.txt`.
 */
export function detectAndParse(bytes: Uint8Array): NormalizedCrash[] {
  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CrashParseError("Crash reports must be UTF-8 text or JSON");
  }
  if (!contents.trim()) throw new CrashParseError("The crash report is empty");

  if (splitIps(contents)) return [parseIps(contents)];

  const trimmed = contents.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new CrashParseError(
        "The JSON is neither an .ips report nor a MetricKit payload",
      );
    }
    if (isMetricKitPayload(json)) return parseMetricKit(json);
    throw new CrashParseError(
      "The JSON is neither an .ips report nor a MetricKit payload",
    );
  }

  if (looksLikeAppleTextCrash(contents)) return [parseAppleTextCrash(contents)];
  throw new CrashParseError(
    "Unrecognized crash report. Upload a .crash, .ips, or MetricKit JSON file",
    415,
    "UNSUPPORTED_CRASH_FORMAT",
  );
}
