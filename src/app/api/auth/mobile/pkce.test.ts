import { describe, expect, test, vi } from "vitest";

import type { Verification } from "@/generated/prisma/client";

import {
  consumeMobileAuthorizationCode,
  createMobileAuthorizationCode,
  createTelevisionAuthorizationCode,
  isMobileAuthorizationCode,
  isMobileOAuthState,
  isPKCECodeChallenge,
  isPKCECodeVerifier,
  MOBILE_AUTHORIZATION_CODE_TTL_MS,
  type MobileAuthorizationCodeStore,
  pkceChallengeMatches,
  pkceCodeChallenge,
} from "./pkce";

const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function memoryStore() {
  const records = new Map<string, Verification>();
  const verification = {
    deleteMany: vi.fn(async ({ where }) => {
      let count = 0;
      for (const [id, record] of records) {
        if (
          record.identifier === where.identifier &&
          record.expiresAt <= where.expiresAt.lte
        ) {
          records.delete(id);
          count += 1;
        }
      }
      return { count };
    }),
    create: vi.fn(async ({ data }) => {
      const timestamp = new Date();
      const record: Verification = {
        createdAt: timestamp,
        updatedAt: timestamp,
        ...data,
      };
      records.set(record.id, record);
      return record;
    }),
    delete: vi.fn(async ({ where }) => {
      const record = records.get(where.id);
      if (!record) throw { code: "P2025" };
      records.delete(where.id);
      return record;
    }),
  };
  return {
    records,
    store: { verification } as unknown as MobileAuthorizationCodeStore,
    verification,
  };
}

describe("mobile PKCE", () => {
  test("matches the RFC 7636 S256 example", () => {
    expect(pkceCodeChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
    expect(pkceChallengeMatches(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
    expect(pkceChallengeMatches("a".repeat(43), RFC_CHALLENGE)).toBe(false);
  });

  test("validates the fixed app state, challenge, code, and verifier formats", () => {
    expect(isMobileOAuthState("s".repeat(43))).toBe(true);
    expect(isPKCECodeChallenge(RFC_CHALLENGE)).toBe(true);
    expect(isMobileAuthorizationCode("a".repeat(43))).toBe(true);
    expect(isPKCECodeVerifier(RFC_VERIFIER)).toBe(true);
    expect(isPKCECodeVerifier("~".repeat(128))).toBe(true);

    expect(isMobileOAuthState("short")).toBe(false);
    expect(isPKCECodeChallenge(`${"a".repeat(42)}=`)).toBe(false);
    expect(isMobileAuthorizationCode("a".repeat(44))).toBe(false);
    expect(isPKCECodeVerifier("a".repeat(129))).toBe(false);
  });

  test("stores a random, short-lived code without storing it in plaintext", async () => {
    const { records, store, verification } = memoryStore();
    const now = new Date("2026-08-07T12:00:00.000Z");

    const code = await createMobileAuthorizationCode(
      "one-time-token",
      RFC_CHALLENGE,
      store,
      now,
    );

    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verification.deleteMany).toHaveBeenCalledWith({
      where: {
        identifier: "aide-mobile-pkce",
        expiresAt: { lte: now },
      },
    });
    const [record] = Array.from(records.values());
    expect(record?.id).not.toContain(code);
    expect(record?.identifier).toBe("aide-mobile-pkce");
    expect(record?.expiresAt.getTime()).toBe(
      now.getTime() + MOBILE_AUTHORIZATION_CODE_TTL_MS,
    );
  });

  test("atomically permits only one concurrent redemption", async () => {
    const { store } = memoryStore();
    const now = new Date("2026-08-07T12:00:00.000Z");
    const code = await createMobileAuthorizationCode(
      "one-time-token",
      RFC_CHALLENGE,
      store,
      now,
    );

    const results = await Promise.all([
      consumeMobileAuthorizationCode(code, store, now),
      consumeMobileAuthorizationCode(code, store, now),
    ]);

    expect(results.filter(Boolean)).toEqual([
      { codeChallenge: RFC_CHALLENGE, oneTimeToken: "one-time-token" },
    ]);
  });

  test("stores the television session purpose with the PKCE binding", async () => {
    const { records, store } = memoryStore();
    const code = await createTelevisionAuthorizationCode(
      "one-time-token",
      RFC_CHALLENGE,
      store,
    );
    expect(Array.from(records.values())[0]?.value).toContain(
      '"sessionPurpose":"television"',
    );
    const results = await Promise.all([
      consumeMobileAuthorizationCode(code, store),
      consumeMobileAuthorizationCode(code, store),
    ]);
    expect(results.filter(Boolean)).toEqual([
      {
        codeChallenge: RFC_CHALLENGE,
        oneTimeToken: "one-time-token",
        sessionPurpose: "television",
      },
    ]);
  });

  test("rejects unknown stored purposes instead of adopting legacy session behavior", async () => {
    const { records, store } = memoryStore();
    const code = await createTelevisionAuthorizationCode(
      "one-time-token",
      RFC_CHALLENGE,
      store,
    );
    const record = Array.from(records.values())[0]!;
    record.value = JSON.stringify({
      codeChallenge: RFC_CHALLENGE,
      oneTimeToken: "one-time-token",
      sessionPurpose: "unknown",
    });
    await expect(
      consumeMobileAuthorizationCode(code, store),
    ).resolves.toBeNull();
    expect(records.size).toBe(0);
  });

  test("consumes and rejects an expired authorization code", async () => {
    const { records, store } = memoryStore();
    const issuedAt = new Date("2026-08-07T12:00:00.000Z");
    const code = await createMobileAuthorizationCode(
      "one-time-token",
      RFC_CHALLENGE,
      store,
      issuedAt,
    );

    await expect(
      consumeMobileAuthorizationCode(
        code,
        store,
        new Date(issuedAt.getTime() + MOBILE_AUTHORIZATION_CODE_TTL_MS + 1),
      ),
    ).resolves.toBeNull();
    expect(records.size).toBe(0);
  });
});
