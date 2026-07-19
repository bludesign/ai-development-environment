import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ARTIFACT_TOKEN_TTL_MS = 15 * 60_000;

let generatedSecret: string | null = null;

/**
 * A per-process fallback keeps links unguessable without requiring configuration.
 * Outstanding links stop working on restart, which is acceptable for links meant
 * to live minutes, and avoids persisting a secret this server has nowhere to put.
 */
function secret(): string {
  const configured = process.env.OTA_TOKEN_SECRET?.trim();
  if (configured) return configured;
  generatedSecret ??= randomBytes(32).toString("hex");
  return generatedSecret;
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
