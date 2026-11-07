import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  database: undefined as unknown,
  auth: undefined as unknown,
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => state.database,
}));
vi.mock("@/services/auth", async (original) => ({
  ...(await original<typeof import("@/services/auth")>()),
  getAuth: async () => state.auth,
}));

import { PrismaClient } from "@/generated/prisma/client";
import { createAuth } from "@/services/auth/auth";
import { getAuthRuntimeConfig } from "@/services/auth/auth-config";
import { GET as complete } from "./complete/route";
import { createMobileAuthorizationCode, pkceCodeChallenge } from "./pkce";
import { POST as redeem } from "./redeem/route";
import { GET as start } from "./start/route";

const origin = "http://localhost:31992";
const directory = mkdtempSync(join(tmpdir(), "aide-nearby-auth-"));
const databasePath = join(directory, "auth.db");
const environment = {
  APP_SECRET: "zhDyTms26c9u15SUcFxkhS8S+dCRnouxjPbQMb/haB8=",
  PUBLIC_BASE_URL: origin,
  AUTH_MODE: "password",
  NODE_ENV: "test",
};
const verifier = "v".repeat(43);
let prisma: PrismaClient;
let auth: ReturnType<typeof createAuth>;

beforeAll(async () => {
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  for (const migration of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort()) {
    sqlite.exec(
      readFileSync(
        join("prisma/migrations", migration, "migration.sql"),
        "utf8",
      ),
    );
  }
  sqlite.close();
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: databasePath }),
  });
  state.database = prisma;
  await prisma.authSettings.create({
    data: {
      id: "default",
      bootstrapCompleted: true,
      registrationEnabled: true,
    },
  });
  auth = createAuth(prisma, getAuthRuntimeConfig(environment), null);
  state.auth = auth;
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Nearby user",
        email: "nearby@example.com",
        password: "example-password-123",
      }),
    }),
  );
  expect(response.status).toBe(200);
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma?.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

async function browserSignIn() {
  const response = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: "nearby@example.com",
        password: "example-password-123",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const session = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  expect(session).not.toBeNull();
  return { cookie, token: session!.session.token, userId: session!.user.id };
}

async function nearbyCode(cookie: string): Promise<string> {
  const url = new URL(`${origin}/api/auth/mobile/start`);
  url.searchParams.set("state", "s".repeat(43));
  url.searchParams.set("code_challenge", pkceCodeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  const started = await start(new Request(url, { headers: { cookie } }));
  expect(started.status).toBe(302);
  const flowCookie = started.headers.get("set-cookie")!.split(";")[0];
  const completed = await complete(
    new Request(started.headers.get("location")!, {
      headers: { cookie: `${cookie}; ${flowCookie}` },
    }),
  );
  return new URL(completed.headers.get("location")!).searchParams.get("code")!;
}

function redeemCode(code: string) {
  return redeem(
    new Request(`${origin}/api/auth/mobile/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "AI Dev Apple TV integration test",
      },
      body: JSON.stringify({ code, code_verifier: verifier }),
    }),
  );
}

async function sessionFor(token: string) {
  return auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
}

describe("nearby TV sessions with SQLite", () => {
  test.each(["browser", "television"])(
    "keeps the other device signed in after %s signs out",
    async (device) => {
      const browser = await browserSignIn();
      const response = await redeemCode(await nearbyCode(browser.cookie));
      expect(response.status).toBe(200);
      const television = await response.json();
      expect(television.token).not.toBe(browser.token);
      expect((await sessionFor(browser.token))?.session.token).toBe(
        browser.token,
      );
      expect((await sessionFor(television.token))?.user.id).toBe(
        browser.userId,
      );
      const signedOut = device === "browser" ? browser.token : television.token;
      const retained = device === "browser" ? television.token : browser.token;
      await auth.api.signOut({
        headers: new Headers({ authorization: `Bearer ${signedOut}` }),
      });
      expect(await sessionFor(signedOut)).toBeNull();
      expect((await sessionFor(retained))?.user.id).toBe(browser.userId);
    },
  );

  test("creates at most one session for concurrent redemption", async () => {
    const browser = await browserSignIn();
    const code = await nearbyCode(browser.cookie);
    const before = await prisma.session.count();
    const responses = await Promise.all([redeemCode(code), redeemCode(code)]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    expect(await prisma.session.count()).toBe(before + 1);
  });

  test("refuses source revocation before redemption without issuing a TV session", async () => {
    const browser = await browserSignIn();
    const code = await nearbyCode(browser.cookie);
    await auth.api.signOut({
      headers: new Headers({ authorization: `Bearer ${browser.token}` }),
    });
    const before = await prisma.session.count();
    expect((await redeemCode(code)).status).toBe(400);
    expect(await prisma.session.count()).toBe(before);
  });

  test("preserves the existing iOS exchange behavior", async () => {
    const browser = await browserSignIn();
    const { token } = await auth.api.generateOneTimeToken({
      headers: new Headers({ cookie: browser.cookie }),
    });
    const code = await createMobileAuthorizationCode(
      token,
      pkceCodeChallenge(verifier),
    );
    const before = await prisma.session.count();
    const response = await redeemCode(code);
    expect(response.status).toBe(200);
    expect((await response.json()).token).toBe(browser.token);
    expect(await prisma.session.count()).toBe(before);
  });
});
