import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";

const state = vi.hoisted(() => ({
  database: undefined as unknown,
  auth: undefined as unknown,
  metadataFetch: vi.fn(),
}));
vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: state.metadataFetch,
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => state.database,
}));
vi.mock("./auth", async (original) => ({
  ...(await original<typeof import("./auth")>()),
  getAuth: async () => state.auth,
}));

import { createAuth } from "./auth";
import { getAuthRuntimeConfig } from "./auth-config";
import { getMcpOAuthConfig } from "./mcp-oauth-config";
import {
  activeMcpAuthorization,
  authorizeMcpOAuthRequest,
  disconnectMcpClient,
  principalFromMcpClaims,
} from "./mcp-oauth";
import { MCP_AUTHORIZATION_CLAIM } from "./mcp-oauth-provider";
import {
  GET as connections,
  DELETE as disconnect,
} from "@/app/api/auth/mcp-connections/route";

const origin = "http://localhost:31991";
const environment = {
  APP_SECRET: "zhDyTms26c9u15SUcFxkhS8S+dCRnouxjPbQMb/haB8=",
  PUBLIC_BASE_URL: origin,
  MCP_OAUTH_ENABLED: "true",
  MCP_OAUTH_DCR_ENABLED: "true",
  NODE_ENV: "test",
};
const config = getMcpOAuthConfig(environment)!;
const directory = mkdtempSync(join(tmpdir(), "aide-mcp-oauth-"));
const databasePath = join(directory, "oauth.db");
let prisma: PrismaClient;
let auth: ReturnType<typeof createAuth>;
let cookie: string;
let userId: string;
let clientId: string;
const redirectUri = "http://127.0.0.1:32123/callback";

async function request(path: string, body?: unknown, authenticated = false) {
  const headers = new Headers({ accept: "application/json", origin });
  if (authenticated) headers.set("cookie", cookie);
  if (body !== undefined) headers.set("content-type", "application/json");
  return auth.handler(
    new Request(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function token(body: Record<string, string>) {
  return auth.handler(
    new Request(`${config.issuer}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
  );
}

async function revokeApproval(
  authorizationId: string,
  oauthClientId = clientId,
) {
  return disconnect(
    new Request(`${origin}/api/auth/mcp-connections`, {
      method: "DELETE",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ clientId: oauthClientId, authorizationId }),
    }),
  );
}

async function begin(
  scopes = "mcp:read mcp:write mcp:destructive offline_access",
  oauthClientId = clientId,
) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: oauthClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    resource: config.resource,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "opaque-client-state",
    prompt: "consent",
  });
  const response = await request(
    `/api/auth/oauth2/authorize?${query}`,
    undefined,
    true,
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.redirect).toBe(true);
  expect(new URL(result.url, origin).pathname).toBe("/mcp/consent");
  return { verifier, oauthQuery: new URL(result.url, origin).search.slice(1) };
}

async function approve(
  scope = "mcp:read offline_access",
  oauthClientId = clientId,
) {
  const flow = await begin(undefined, oauthClientId);
  const consent = await request(
    "/api/auth/oauth2/consent",
    { accept: true, scope, oauth_query: flow.oauthQuery },
    true,
  );
  expect(consent.status).toBe(200);
  const result = await consent.json();
  const callback = new URL(result.url);
  expect(callback.searchParams.get("state")).toBe("opaque-client-state");
  return { code: callback.searchParams.get("code")!, verifier: flow.verifier };
}

async function issue(
  scope = "mcp:read offline_access",
  oauthClientId = clientId,
) {
  const flow = await approve(scope, oauthClientId);
  const response = await token({
    grant_type: "authorization_code",
    client_id: oauthClientId,
    redirect_uri: redirectUri,
    resource: config.resource,
    code: flow.code,
    code_verifier: flow.verifier,
  });
  const body = await response.json();
  expect(body.error).toBeUndefined();
  expect(response.status).toBe(200);
  return body as {
    access_token: string;
    refresh_token?: string;
    scope: string;
    expires_in: number;
  };
}

beforeAll(async () => {
  const sqlite = new Database(databasePath);
  // Use the application's WAL/NORMAL settings for the full migration replay
  // on CI runners with slower filesystem syncs.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  const migrations = readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort();
  for (const migration of migrations.filter(
    (name) => name !== "20261027060000_mcp_oauth",
  ))
    sqlite.exec(
      readFileSync(
        join("prisma/migrations", migration, "migration.sql"),
        "utf8",
      ),
    );
  // Exercise the additive migration against a populated database.
  sqlite
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)',
    )
    .run(
      "existing-user",
      "Existing user",
      "existing@example.com",
      Date.now(),
      Date.now(),
    );
  sqlite.exec(
    readFileSync(
      "prisma/migrations/20261027060000_mcp_oauth/migration.sql",
      "utf8",
    ),
  );
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
  auth = createAuth(prisma, getAuthRuntimeConfig(environment), config);
  state.auth = auth;
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  const signup = await request("/api/auth/sign-up/email", {
    name: "MCP user",
    email: "mcp@example.com",
    password: "example-password-123",
  });
  const signupBody = await signup.json();
  expect(signupBody.user?.id).toBeTruthy();
  userId = signupBody.user.id;
  cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const registration = await request("/api/auth/oauth2/register", {
    client_name: "Integration MCP client",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
  });
  const registered = await registration.json();
  expect(registered.error).toBeUndefined();
  clientId = registered.client_id;
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).origin === origin) return auth.handler(request);
      return originalFetch(input, init);
    },
  );
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await prisma?.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});

describe("MCP OAuth provider with SQLite", () => {
  test.each(
    (
      [
        ["http://192.168.1.50:3000", false],
        ["https://control.example", true],
      ] as const
    ).flatMap(([browserOrigin, secure]) =>
      [true, false].map((enabled) => ({
        browserOrigin,
        secure,
        enabled,
      })),
    ),
  )(
    "preserves browser sessions on $browserOrigin with MCP OAuth $enabled",
    async ({ browserOrigin, secure, enabled }) => {
      const multiOriginEnvironment = {
        ...environment,
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://control.example",
        APP_ORIGINS: "https://control.example,http://192.168.1.50:3000",
      };
      const oauthConfig = getMcpOAuthConfig(multiOriginEnvironment)!;
      const instance = createAuth(
        prisma,
        getAuthRuntimeConfig(multiOriginEnvironment),
        enabled ? oauthConfig : null,
      );
      const signedIn = await instance.handler(
        new Request(`${browserOrigin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            origin: browserOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: "mcp@example.com",
            password: "example-password-123",
          }),
        }),
      );
      expect(signedIn.status).toBe(200);
      const sessionCookie = signedIn.headers
        .getSetCookie()
        .find((value) => value.includes("session_token="))!;
      expect(sessionCookie.includes("; Secure")).toBe(secure);
      expect(sessionCookie.startsWith("__Secure-")).toBe(secure);
      const headers = new Headers({
        cookie: sessionCookie.split(";")[0],
        host: new URL(browserOrigin).host,
      });
      const session = await instance.handler(
        new Request(`${browserOrigin}/api/auth/get-session`, { headers }),
      );
      expect((await session.json()).user.id).toBe(userId);
      expect((await instance.api.getSession({ headers }))?.user.id).toBe(
        userId,
      );
      const metadata = await instance.handler(
        new Request(
          `${oauthConfig.origin}/.well-known/oauth-authorization-server/api/auth`,
        ),
      );
      if (!enabled) {
        expect(metadata.status).toBe(404);
        return;
      }
      expect(await metadata.json()).toMatchObject({
        issuer: oauthConfig.issuer,
        authorization_endpoint: `${oauthConfig.issuer}/oauth2/authorize`,
        token_endpoint: `${oauthConfig.issuer}/oauth2/token`,
        jwks_uri: `${oauthConfig.issuer}/jwks`,
      });
    },
  );

  test.each(["0", "60"])(
    "continues max_age=%s authorization after fresh password authentication",
    async (maxAge) => {
      const session = (await auth.api.getSession({
        headers: new Headers({ cookie }),
      }))!.session;
      await prisma.session.update({
        where: { id: session.id },
        data: { createdAt: new Date(Date.now() - 3_600_000) },
      });
      try {
        const verifier = randomBytes(32).toString("base64url");
        const query = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "mcp:read",
          resource: config.resource,
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
          max_age: maxAge,
        });
        const authorization = await request(
          `/api/auth/oauth2/authorize?${query}`,
          undefined,
          true,
        );
        const signIn = new URL((await authorization.json()).url, origin);
        expect(signIn.pathname).toBe("/mcp/sign-in");
        const signedIn = await request(
          "/api/auth/sign-in/email",
          {
            email: "mcp@example.com",
            password: "example-password-123",
            oauth_query: signIn.search.slice(1),
          },
          true,
        );
        expect(signedIn.status).toBe(200);
        const consent = new URL((await signedIn.json()).url, origin);
        expect(consent.pathname).toBe("/mcp/consent");
        expect(consent.searchParams.has("max_age")).toBe(false);
      } finally {
        await prisma.session.update({
          where: { id: session.id },
          data: { createdAt: session.createdAt },
        });
      }
    },
  );

  test("preserves populated data and serves canonical public discovery and durable keys", async () => {
    expect(
      await prisma.user.findUnique({ where: { id: "existing-user" } }),
    ).not.toBeNull();
    const discovery = await request(
      "/.well-known/oauth-authorization-server/api/auth",
    );
    expect(await discovery.json()).toMatchObject({
      issuer: config.issuer,
      grant_types_supported: ["authorization_code", "refresh_token"],
      client_id_metadata_document_supported: true,
    });
    const metadata = await request(
      "/.well-known/oauth-protected-resource/api/mcp",
    );
    expect(await metadata.json()).toMatchObject({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: ["mcp:read", "mcp:write", "mcp:destructive"],
    });
    const first = await (await request("/api/auth/jwks")).json();
    const restarted = createAuth(
      prisma,
      getAuthRuntimeConfig(environment),
      config,
    );
    const second = await (
      await restarted.handler(new Request(`${config.issuer}/jwks`))
    ).json();
    expect(second).toEqual(first);
    expect(await prisma.jwks.count()).toBeGreaterThan(0);
  });
  test("identifies CIMD clients without enabling DCR and binds their consent to tokens", async () => {
    const metadataId = "https://clients.example/mcp.json";
    state.metadataFetch.mockImplementation(async () =>
      Response.json(
        {
          client_id: metadataId,
          client_name: "CIMD test client",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          application_type: "native",
          grant_types: ["authorization_code", "refresh_token"],
        },
        { headers: { "cache-control": "max-age=300" } },
      ),
    );
    const cimdAuth = createAuth(prisma, getAuthRuntimeConfig(environment), {
      ...config,
      dcrEnabled: false,
    });
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: metadataId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "mcp:read",
      resource: config.resource,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "cimd-state",
    });
    const response = await cimdAuth.handler(
      new Request(`${config.issuer}/oauth2/authorize?${query}`, {
        headers: { cookie, accept: "application/json" },
      }),
    );
    const result = await response.json();
    expect(result.error).toBeUndefined();
    expect(response.status).toBe(200);
    const consentUrl = new URL(result.url, origin);
    expect(consentUrl.pathname).toBe("/mcp/consent");
    expect(state.metadataFetch).toHaveBeenCalled();
    expect(
      (await prisma.oauthClient.findUnique({ where: { clientId: metadataId } }))
        ?.clientDiscoveryId,
    ).toBe("cimd");
    const accepted = await cimdAuth.handler(
      new Request(`${config.issuer}/oauth2/consent`, {
        method: "POST",
        headers: {
          cookie,
          origin,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accept: true,
          scope: "mcp:read",
          oauth_query: consentUrl.search.slice(1),
        }),
      }),
    );
    const callback = new URL((await accepted.json()).url);
    const issued = await token({
      grant_type: "authorization_code",
      client_id: metadataId,
      redirect_uri: redirectUri,
      resource: config.resource,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
    });
    const tokens = await issued.json();
    expect(tokens.error).toBeUndefined();
    expect(
      (await principalFromMcpClaims(decodeJwt(tokens.access_token)))?.clientId,
    ).toBe(metadataId);
  });
  test("denies consent and enforces PKCE without issuing tokens", async () => {
    const flow = await begin();
    const denied = await request(
      "/api/auth/oauth2/consent",
      { accept: false, scope: "mcp:read", oauth_query: flow.oauthQuery },
      true,
    );
    const result = await denied.json();
    expect(new URL(result.url).searchParams.get("error")).toBe("access_denied");
    const code = await approve();
    const badPkce = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      resource: config.resource,
      code: code.code,
      code_verifier: "incorrect-verifier",
    });
    expect(badPkce.status).toBe(400);
  });
  test("grants only selected scopes, issues five-minute tokens and rotates refresh credentials", async () => {
    const issued = await issue();
    expect(issued.scope.split(" ").sort()).toEqual(
      ["mcp:read", "offline_access"].sort(),
    );
    const claims = decodeJwt(issued.access_token);
    expect(claims.exp! - claims.iat!).toBe(300);
    const principal = await principalFromMcpClaims(claims);
    expect(principal).toMatchObject({
      userId,
      clientId,
      scopes: ["mcp:read", "offline_access"],
    });
    expect(
      await authorizeMcpOAuthRequest(
        new Request(config.resource, {
          headers: { authorization: `Bearer ${issued.access_token}` },
        }),
      ),
    ).toHaveProperty("principal");
    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      resource: config.resource,
      refresh_token: issued.refresh_token!,
    });
    const next = await refreshed.json();
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(issued.refresh_token);
    expect(decodeJwt(next.access_token)[MCP_AUTHORIZATION_CLAIM]).toBe(
      claims[MCP_AUTHORIZATION_CLAIM],
    );
    const replay = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      resource: config.resource,
      refresh_token: issued.refresh_token!,
    });
    expect(replay.status).toBe(400);
  });
  test("disconnect immediately invalidates access, refresh, and outstanding codes; fresh consent never revives old tokens", async () => {
    const issued = await issue();
    const outstanding = await approve();
    const claims = decodeJwt(issued.access_token);
    const oldPrincipal = (await principalFromMcpClaims(claims))!;
    await disconnectMcpClient(userId, clientId);
    expect(await activeMcpAuthorization(oldPrincipal)).toBe(false);
    const denied = await authorizeMcpOAuthRequest(
      new Request(config.resource, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect("response" in denied && denied.response.status).toBe(401);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: clientId,
          resource: config.resource,
          refresh_token: issued.refresh_token!,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await token({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirectUri,
          resource: config.resource,
          code: outstanding.code,
          code_verifier: outstanding.verifier,
        })
      ).status,
    ).toBe(400);
    const fresh = await issue();
    expect(decodeJwt(fresh.access_token)[MCP_AUTHORIZATION_CLAIM]).not.toBe(
      claims[MCP_AUTHORIZATION_CLAIM],
    );
    expect(await principalFromMcpClaims(claims)).toBeNull();
  });
  test("revokes one approval and its rotated credentials without affecting another approval", async () => {
    const issued = await issue("mcp:read mcp:write offline_access");
    const survivor = await issue();
    const claims = decodeJwt(issued.access_token);
    const authorizationId = claims[MCP_AUTHORIZATION_CLAIM] as string;
    const principal = (await principalFromMcpClaims(claims))!;
    const authorization = await prisma.mcpAuthorization.findUniqueOrThrow({
      where: { id: authorizationId },
    });
    // Cover opaque provider credentials bound by code id as well as JWT/refresh references.
    await prisma.oauthAccessToken.create({
      data: {
        id: "single-revoke-opaque",
        token: "single-revoke-opaque-hash",
        userId,
        clientId,
        authorizationCodeId: authorization.authorizationCodeId,
        scopes: "mcp:read",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    const rotation = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      resource: config.resource,
      refresh_token: issued.refresh_token!,
    });
    expect(rotation.status).toBe(200);
    const rotated = await rotation.json();
    const consentBefore = await prisma.oauthConsent.findMany({
      where: { userId, clientId },
    });
    expect(consentBefore.length).toBeGreaterThan(0);

    const response = await revokeApproval(authorizationId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await activeMcpAuthorization(principal)).toBe(false);
    expect(await principalFromMcpClaims(claims)).toBeNull();
    expect(
      await principalFromMcpClaims(decodeJwt(rotated.access_token)),
    ).toBeNull();
    const denied = await authorizeMcpOAuthRequest(
      new Request(config.resource, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect("response" in denied && denied.response.status).toBe(401);
    expect(
      await prisma.oauthRefreshToken.count({
        where: { userId, clientId, referenceId: authorizationId },
      }),
    ).toBe(0);
    expect(
      await prisma.oauthAccessToken.findUnique({
        where: { id: "single-revoke-opaque" },
      }),
    ).toBeNull();
    for (const refreshToken of [issued.refresh_token!, rotated.refresh_token]) {
      expect(
        (
          await token({
            grant_type: "refresh_token",
            client_id: clientId,
            resource: config.resource,
            refresh_token: refreshToken,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      await principalFromMcpClaims(decodeJwt(survivor.access_token)),
    ).not.toBeNull();
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: clientId,
          resource: config.resource,
          refresh_token: survivor.refresh_token!,
        })
      ).status,
    ).toBe(200);
    expect(
      await prisma.oauthConsent.findMany({ where: { userId, clientId } }),
    ).toEqual(consentBefore);
    expect((await revokeApproval(authorizationId)).status).toBe(200);
    const listing = await connections(
      new Request(`${origin}/api/auth/mcp-connections`, {
        headers: { cookie, origin },
      }),
    );
    const client = (await listing.json()).clients.find(
      (item: { clientId: string }) => item.clientId === clientId,
    );
    expect(
      client.authorizations.some(
        (item: { id: string }) => item.id === authorizationId,
      ),
    ).toBe(false);
    expect(
      client.authorizations.some(
        (item: { id: string }) =>
          item.id === decodeJwt(survivor.access_token)[MCP_AUTHORIZATION_CLAIM],
      ),
    ).toBe(true);
  });
  test("revoking an approval invalidates its pending code and checks user and client ownership", async () => {
    const before = await prisma.mcpAuthorization.findMany({
      where: { userId, clientId },
      select: { id: true },
    });
    const flow = await approve();
    const authorization = await prisma.mcpAuthorization.findFirstOrThrow({
      where: { userId, clientId, id: { notIn: before.map((item) => item.id) } },
    });
    const foreign = await prisma.mcpAuthorization.create({
      data: {
        id: "single-revoke-foreign",
        authorizationCodeId: "single-revoke-foreign-code",
        userId: "existing-user",
        clientId,
        clientName: "Other user's approval",
        scopes: "mcp:read",
      },
    });
    for (const [id, requestedClient] of [
      [foreign.id, clientId],
      [authorization.id, "wrong-client"],
      ["missing-approval", clientId],
    ]) {
      expect((await revokeApproval(id, requestedClient)).status).toBe(404);
    }
    for (const body of [
      { clientId, authorizationId: "" },
      { clientId, authorizationId: null },
      { clientId, authorizationID: authorization.id },
    ]) {
      expect(
        (
          await disconnect(
            new Request(`${origin}/api/auth/mcp-connections`, {
              method: "DELETE",
              headers: { cookie, origin, "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await disconnect(
          new Request(`${origin}/api/auth/mcp-connections`, {
            method: "DELETE",
            headers: {
              cookie,
              origin: "https://attacker.example",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              clientId,
              authorizationId: authorization.id,
            }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await prisma.mcpAuthorization.findUniqueOrThrow({
          where: { id: authorization.id },
        })
      ).revokedAt,
    ).toBeNull();
    expect((await revokeApproval(authorization.id)).status).toBe(200);
    expect(
      (
        await token({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirectUri,
          resource: config.resource,
          code: flow.code,
          code_verifier: flow.verifier,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await prisma.mcpAuthorization.findUniqueOrThrow({
          where: { id: foreign.id },
        })
      ).revokedAt,
    ).toBeNull();
  });
  test("revoking the last approval removes the application and clears its consent", async () => {
    const registration = await request("/api/auth/oauth2/register", {
      client_name: "Single approval client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    const isolatedClientId = (await registration.json()).client_id;
    const issued = await issue("mcp:read offline_access", isolatedClientId);
    const claims = decodeJwt(issued.access_token);
    expect(
      await prisma.oauthConsent.count({
        where: { userId, clientId: isolatedClientId },
      }),
    ).toBeGreaterThan(0);
    expect(
      (
        await revokeApproval(
          claims[MCP_AUTHORIZATION_CLAIM] as string,
          isolatedClientId,
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.oauthConsent.count({
        where: { userId, clientId: isolatedClientId },
      }),
    ).toBe(0);
    expect(await principalFromMcpClaims(claims)).toBeNull();
    const listing = await connections(
      new Request(`${origin}/api/auth/mcp-connections`, {
        headers: { cookie, origin },
      }),
    );
    expect(
      (await listing.json()).clients.some(
        (item: { clientId: string }) => item.clientId === isolatedClientId,
      ),
    ).toBe(false);
    const fresh = await issue("mcp:read offline_access", isolatedClientId);
    expect(decodeJwt(fresh.access_token)[MCP_AUTHORIZATION_CLAIM]).not.toBe(
      claims[MCP_AUTHORIZATION_CLAIM],
    );
    expect(await principalFromMcpClaims(claims)).toBeNull();
  });
  test("rejects invalid signatures, issuers, audiences, expiry and mixed identities", async () => {
    const issued = await issue();
    const claims = decodeJwt(issued.access_token);
    for (const changes of [
      { iss: "https://wrong.example/api/auth" },
      { aud: `${config.resource}?preset=other` },
      { exp: Math.floor(Date.now() / 1000) - 60 },
    ]) {
      const signed = await auth.api.signJWT({
        body: { payload: { ...claims, ...changes } },
      });
      const result = await authorizeMcpOAuthRequest(
        new Request(config.resource, {
          headers: { authorization: `Bearer ${signed.token}` },
        }),
      );
      expect("response" in result && result.response.status).toBe(401);
    }
    const parts = issued.access_token.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({
        ...claims,
        scope: "mcp:read mcp:write mcp:destructive",
      }),
    ).toString("base64url");
    const tampered = await authorizeMcpOAuthRequest(
      new Request(config.resource, {
        headers: { authorization: `Bearer ${parts.join(".")}` },
      }),
    );
    expect("response" in tampered && tampered.response.status).toBe(401);
    await expect(
      authorizeMcpOAuthRequest(
        new Request(config.resource, {
          headers: {
            authorization: `Bearer ${issued.access_token}`,
            "x-api-key": "aide_other",
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("disables OAuth independently and leaves discovery and DCR absent by default", async () => {
    const withoutDcr = createAuth(prisma, getAuthRuntimeConfig(environment), {
      ...config,
      dcrEnabled: false,
    });
    const discovery = await withoutDcr.handler(
      new Request(`${origin}/.well-known/oauth-authorization-server/api/auth`),
    );
    expect(await discovery.json()).not.toHaveProperty("registration_endpoint");
    const registration = await withoutDcr.handler(
      new Request(`${config.issuer}/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirectUri] }),
      }),
    );
    expect(registration.ok).toBe(false);
    const disabled = createAuth(
      prisma,
      getAuthRuntimeConfig(environment),
      null,
    );
    expect(
      (
        await disabled.handler(
          new Request(`${origin}/.well-known/oauth-protected-resource`),
        )
      ).status,
    ).toBe(404);
    const issued = await issue();
    vi.stubEnv("MCP_OAUTH_ENABLED", "false");
    const result = await authorizeMcpOAuthRequest(
      new Request(config.resource, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect("response" in result && result.response.status).toBe(401);
    vi.stubEnv("MCP_OAUTH_ENABLED", "true");
  });
  test("summarizes only the user's current authorizations without exposing credential data", async () => {
    const base = {
      userId,
      clientId: "connection-details-client",
      clientName: "Original name",
      scopes: "mcp:read",
      createdAt: new Date("2026-07-01T12:00:00Z"),
    };
    await prisma.mcpAuthorization.createMany({
      data: [
        {
          ...base,
          id: "details-first",
          authorizationCodeId: "details-first-code",
        },
        {
          ...base,
          id: "details-latest",
          authorizationCodeId: "details-latest-code",
          clientName: "Current name",
          scopes: "mcp:read mcp:write offline_access",
          createdAt: new Date("2026-08-01T12:00:00Z"),
        },
        {
          ...base,
          id: "details-revoked",
          authorizationCodeId: "details-revoked-code",
          scopes: "mcp:destructive",
          createdAt: new Date("2026-09-01T12:00:00Z"),
          revokedAt: new Date(),
        },
        {
          ...base,
          id: "details-foreign",
          authorizationCodeId: "details-foreign-code",
          userId: "existing-user",
          clientName: "Other user's name",
          scopes: "mcp:destructive",
          createdAt: new Date("2026-10-01T12:00:00Z"),
        },
      ],
    });
    const response = await connections(
      new Request(`${origin}/api/auth/mcp-connections`, {
        headers: { cookie, origin },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(
      body.clients.find(
        (client: { clientId: string }) => client.clientId === base.clientId,
      ),
    ).toEqual({
      clientId: base.clientId,
      name: "Current name",
      scopes: ["mcp:read", "mcp:write", "offline_access"],
      connectedAt: "2026-08-01T12:00:00.000Z",
      firstAuthorizedAt: "2026-07-01T12:00:00.000Z",
      authorizationCount: 2,
      authorizations: [
        {
          id: "details-latest",
          authorizedAt: "2026-08-01T12:00:00.000Z",
          scopes: ["mcp:read", "mcp:write", "offline_access"],
        },
        {
          id: "details-first",
          authorizedAt: "2026-07-01T12:00:00.000Z",
          scopes: ["mcp:read"],
        },
      ],
    });
  });
  test("lists and disconnects only the current user's clients", async () => {
    const other = await prisma.mcpAuthorization.create({
      data: {
        id: "other-authorization",
        authorizationCodeId: "other-code",
        userId: "existing-user",
        clientId: "other-client",
        clientName: "Other user's client",
        scopes: "mcp:read",
      },
    });
    const response = await connections(
      new Request(`${origin}/api/auth/mcp-connections`, {
        headers: { cookie, origin },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.clients.some(
        (client: { clientId: string }) => client.clientId === "other-client",
      ),
    ).toBe(false);
    const result = await disconnect(
      new Request(`${origin}/api/auth/mcp-connections`, {
        method: "DELETE",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ clientId: "other-client" }),
      }),
    );
    expect(result.status).toBe(200);
    expect(
      (await prisma.mcpAuthorization.findUnique({ where: { id: other.id } }))
        ?.revokedAt,
    ).toBeNull();
    const issued = await issue();
    const jwtAccess = await connections(
      new Request(`${origin}/api/auth/mcp-connections`, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
    );
    expect(jwtAccess.status).toBe(401);
    const crossSite = await disconnect(
      new Request(`${origin}/api/auth/mcp-connections`, {
        method: "DELETE",
        headers: {
          cookie,
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ clientId }),
      }),
    );
    expect(crossSite.status).toBe(403);
  });
  test("continues incoming OAuth through password and existing OIDC sign-in", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "mcp:read",
      resource: config.resource,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "login-continuation",
      prompt: "consent",
    });
    const anonymous = await request(`/api/auth/oauth2/authorize?${query}`);
    const login = await anonymous.json();
    expect(new URL(login.url, origin).pathname).toBe("/mcp/sign-in");
    const oauthQuery = new URL(login.url, origin).search.slice(1);
    const signedIn = await request("/api/auth/sign-in/email", {
      email: "mcp@example.com",
      password: "example-password-123",
      oauth_query: oauthQuery,
    });
    const passwordContinuation = await signedIn.json();
    expect(new URL(passwordContinuation.url, origin).pathname).toBe(
      "/mcp/consent",
    );
    const oidcEnvironment = {
      ...environment,
      AUTH_MODE: "oidc",
      AUTH_OAUTH_PROVIDER_ID: "company",
      AUTH_OAUTH_PROVIDER_NAME: "Company",
      AUTH_OAUTH_CLIENT_ID: "company-client",
      AUTH_OAUTH_CLIENT_SECRET: "company-secret",
      AUTH_OAUTH_SCOPES: "openid,profile,email",
      AUTH_OAUTH_ISSUER: "https://identity.example",
      AUTH_OAUTH_AUTHORIZATION_URL: "https://identity.example/authorize",
      AUTH_OAUTH_TOKEN_URL: "https://identity.example/token",
      AUTH_OAUTH_USER_INFO_URL: "https://identity.example/userinfo",
    };
    const oidcAuth = createAuth(
      prisma,
      getAuthRuntimeConfig(oidcEnvironment),
      config,
    );
    const previousFetch = globalThis.fetch;
    const providerToken = vi.fn();
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url === "https://identity.example/token") {
          providerToken(await req.text());
          return Response.json({
            access_token: "provider-access",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (req.url === "https://identity.example/userinfo")
          return Response.json({
            id: "company-user",
            sub: "company-user",
            name: "Company user",
            email: "company@example.com",
            email_verified: true,
          });
        return previousFetch(input, init);
      },
    );
    try {
      const signin = await oidcAuth.handler(
        new Request(`${config.issuer}/sign-in/social`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            provider: "company",
            callbackURL: `${origin}/mcp/sign-in?${oauthQuery}`,
            oauth_query: oauthQuery,
          }),
        }),
      );
      const provider = new URL((await signin.json()).url);
      expect(provider.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(provider.searchParams.get("redirect_uri")!);
      expect(callback.pathname).toBe("/api/auth/callback/company");
      callback.searchParams.set("code", "company-code");
      callback.searchParams.set("state", provider.searchParams.get("state")!);
      const oidcCookies = signin.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const completed = await oidcAuth.handler(
        new Request(callback, {
          headers: { cookie: oidcCookies, accept: "text/html" },
        }),
      );
      const destination = new URL(completed.headers.get("location")!, origin);
      expect(destination.pathname).toBe("/mcp/consent");
      expect(destination.searchParams.get("client_id")).toBe(clientId);
      expect(providerToken).toHaveBeenCalled();
      expect(
        new URLSearchParams(providerToken.mock.calls[0][0]).get(
          "code_verifier",
        ),
      ).toBeTruthy();
      const oidcSessionCookies = completed.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const granted = await oidcAuth.handler(
        new Request(`${config.issuer}/oauth2/consent`, {
          method: "POST",
          headers: {
            cookie: oidcSessionCookies,
            origin,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            accept: true,
            scope: "mcp:read",
            oauth_query: destination.search.slice(1),
          }),
        }),
      );
      const grant = new URL((await granted.json()).url);
      expect(grant.searchParams.get("code")).toBeTruthy();
      expect(grant.searchParams.get("state")).toBe("login-continuation");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
  test("blocks access and refresh immediately when the user is deleted", async () => {
    const issued = await issue();
    await prisma.user.delete({ where: { id: userId } });
    expect(
      await principalFromMcpClaims(decodeJwt(issued.access_token)),
    ).toBeNull();
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: clientId,
          resource: config.resource,
          refresh_token: issued.refresh_token!,
        })
      ).status,
    ).toBe(400);
  });
});
