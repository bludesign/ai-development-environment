import { createHmac, timingSafeEqual } from "node:crypto";

import { getAppSecrets } from "./app-secret";

// Match the cache's useful lifetime so a slow or interrupted iOS installation
// can resume with the token embedded in its original manifest.
export const ARTIFACT_TOKEN_TTL_MS = 6 * 60 * 60_000;

/**
 * Derived from APP_SECRET, so links survive a restart. They still stop working
 * after an APP_SECRET rotation, which is acceptable for links that expire in
 * hours anyway.
 */
function secret(): string {
  return getAppSecrets().otaTokenSecret;
}

function sign(artifactId: string, expiresAt: number): string {
  return createHmac("sha256", secret())
    .update(`${artifactId}:${expiresAt}`)
    .digest("base64url");
}

export function signArtifactToken(
  artifactId: string,
  expiresAt: number = Date.now() + ARTIFACT_TOKEN_TTL_MS,
): { token: string; expires: number } {
  return { token: sign(artifactId, expiresAt), expires: expiresAt };
}

/**
 * Verifies a download token. Callers treat a missing token as unauthenticated
 * rather than invalid, so that links minted before this existed keep working.
 */
export function verifyArtifactToken(
  artifactId: string,
  token: string | null,
  expires: string | null,
  now: number = Date.now(),
): boolean {
  if (!token || !expires) return false;
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(sign(artifactId, expiresAt));
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
