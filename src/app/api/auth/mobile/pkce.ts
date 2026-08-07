import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";

import { getPrismaClient } from "@/data/prisma-client";

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const MOBILE_AUTHORIZATION_CODE_IDENTIFIER = "aide-mobile-pkce";
export const MOBILE_AUTHORIZATION_CODE_TTL_MS = 60_000;

const storedAuthorizationSchema = z.object({
  codeChallenge: z.string().regex(BASE64URL_32_BYTES),
  oneTimeToken: z.string().min(1),
});

type StoredAuthorization = z.infer<typeof storedAuthorizationSchema>;

export type MobileAuthorizationCodeStore = Pick<
  Awaited<ReturnType<typeof getPrismaClient>>,
  "verification"
>;

function randomBase64URL(): string {
  return randomBytes(32).toString("base64url");
}

function recordID(code: string): string {
  const digest = createHash("sha256").update(code).digest("base64url");
  return `${MOBILE_AUTHORIZATION_CODE_IDENTIFIER}:${digest}`;
}

function isMissingRecord(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2025"
  );
}

export function isMobileOAuthState(value: string | null): value is string {
  return value !== null && BASE64URL_32_BYTES.test(value);
}

export function isPKCECodeChallenge(value: string | null): value is string {
  return value !== null && BASE64URL_32_BYTES.test(value);
}

export function isPKCECodeVerifier(value: string | null): value is string {
  return value !== null && CODE_VERIFIER.test(value);
}

export function isMobileAuthorizationCode(
  value: string | null,
): value is string {
  return value !== null && BASE64URL_32_BYTES.test(value);
}

export function pkceCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function pkceChallengeMatches(
  verifier: string,
  expectedChallenge: string,
): boolean {
  if (
    !isPKCECodeVerifier(verifier) ||
    !isPKCECodeChallenge(expectedChallenge)
  ) {
    return false;
  }
  const actual = Buffer.from(pkceCodeChallenge(verifier), "ascii");
  const expected = Buffer.from(expectedChallenge, "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createMobileAuthorizationCode(
  oneTimeToken: string,
  codeChallenge: string,
  store?: MobileAuthorizationCodeStore,
  now = new Date(),
): Promise<string> {
  if (!oneTimeToken || !isPKCECodeChallenge(codeChallenge)) {
    throw new TypeError("A token and valid S256 code challenge are required.");
  }
  const prisma = store ?? (await getPrismaClient());
  const code = randomBase64URL();
  const expiresAt = new Date(now.getTime() + MOBILE_AUTHORIZATION_CODE_TTL_MS);

  await prisma.verification.deleteMany({
    where: {
      identifier: MOBILE_AUTHORIZATION_CODE_IDENTIFIER,
      expiresAt: { lte: now },
    },
  });
  await prisma.verification.create({
    data: {
      id: recordID(code),
      identifier: MOBILE_AUTHORIZATION_CODE_IDENTIFIER,
      value: JSON.stringify({ codeChallenge, oneTimeToken }),
      expiresAt,
    },
  });
  return code;
}

/** Atomically consumes a code before its verifier is checked, making every attempt single-use. */
export async function consumeMobileAuthorizationCode(
  code: string,
  store?: MobileAuthorizationCodeStore,
  now = new Date(),
): Promise<StoredAuthorization | null> {
  if (!isMobileAuthorizationCode(code)) return null;
  const prisma = store ?? (await getPrismaClient());

  let record;
  try {
    // Prisma's delete returns the removed row. The unique id makes this the
    // single atomic operation that wins when two redemption requests race.
    record = await prisma.verification.delete({
      where: { id: recordID(code) },
    });
  } catch (error) {
    if (isMissingRecord(error)) return null;
    throw error;
  }
  if (
    record.identifier !== MOBILE_AUTHORIZATION_CODE_IDENTIFIER ||
    record.expiresAt <= now
  ) {
    return null;
  }
  try {
    const parsed = storedAuthorizationSchema.safeParse(
      JSON.parse(record.value) as unknown,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
