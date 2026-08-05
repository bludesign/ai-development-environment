import { apiKey } from "@better-auth/api-key";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import {
  admin,
  bearer,
  createAccessControl,
  genericOAuth,
  oneTimeToken,
} from "better-auth/plugins";

import { betterAuthBaseURL, originFromRequest } from "@/lib/app-origins";
import { getPrismaClient } from "@/data/prisma-client";

import {
  getAuthRuntimeConfig,
  oauthAuthenticationEnabled,
  passwordAuthenticationEnabled,
} from "./auth-config";
import { authDatabaseHooks } from "./registration";

const managementStatements = {
  user: ["create", "list", "set-password", "set-email", "get", "update"],
  session: ["list", "revoke", "delete"],
} as const;
const managementAccess = createAccessControl(managementStatements);
const userManagerRole = managementAccess.newRole(managementStatements);

/**
 * Every account is an administrator (see `adminRoles` below), and the user
 * database hooks pin `role` and the ban columns to fixed values. That makes part
 * of the admin plugin's surface unusable rather than merely unused, so those
 * routes are removed instead of left mounted:
 *
 * - `setRole`, `banUser`, `unbanUser` would return success and silently do
 *   nothing, because `authDatabaseHooks.user.update.before` overwrites the very
 *   columns they set.
 * - `impersonateUser`/`stopImpersonating` have no privilege boundary to enforce
 *   when all accounts are equal; they would let any user assume any other user's
 *   session, and nothing in this deployment reads `Session.impersonatedBy`.
 * - `removeUser` deletes sessions and accounts before the user row, outside one
 *   transaction. The management route replaces it with an atomic conditional
 *   delete so two users cannot concurrently delete each other and empty the
 *   instance.
 *
 * Dropping the endpoints also drops them from `auth.api`, so a future caller gets
 * a type error rather than a silent no-op. The return type is inferred rather than
 * annotated: spelling it out as an `Omit` of the plugin widens `id` off its literal
 * type, which breaks Better Auth's inference of `auth.api` for every other plugin.
 */
function managementAdminPlugin() {
  const plugin = admin({
    ac: managementAccess,
    roles: { user: userManagerRole },
    defaultRole: "user",
    adminRoles: ["user"],
  });
  const {
    setRole: _setRole,
    banUser: _banUser,
    unbanUser: _unbanUser,
    impersonateUser: _impersonateUser,
    stopImpersonating: _stopImpersonating,
    removeUser: _removeUser,
    ...endpoints
  } = plugin.endpoints;
  return { ...plugin, endpoints };
}

function createAuth(
  prisma: Awaited<ReturnType<typeof getPrismaClient>>,
  runtime = getAuthRuntimeConfig(),
) {
  const oauthPlugin =
    oauthAuthenticationEnabled(runtime.mode) && runtime.provider
      ? genericOAuth({
          config: [
            {
              providerId: runtime.provider.providerId,
              clientId: runtime.provider.clientId,
              clientSecret: runtime.provider.clientSecret,
              scopes: runtime.provider.scopes,
              discoveryUrl: runtime.provider.discoveryUrl,
              issuer: runtime.provider.issuer,
              authorizationUrl: runtime.provider.authorizationUrl,
              tokenUrl: runtime.provider.tokenUrl,
              userInfoUrl: runtime.provider.userInfoUrl,
              pkce: true,
              requireIssuerValidation: runtime.provider.requireIssuerValidation,
              disableImplicitSignUp: false,
            },
          ],
        })
      : null;

  return betterAuth({
    appName: "AI Development Environment",
    // A single exact origin pins baseURL statically so no host-header logic runs.
    // Anything broader resolves per request against the APP_ORIGINS allowlist,
    // which is also what Better Auth derives its trusted origins from — so the
    // CSRF check and the callbackURL/redirectTo check follow APP_ORIGINS too.
    baseURL: betterAuthBaseURL(runtime.origins),
    // Adds to whatever the baseURL already implies, rather than replacing it, so
    // this contributes nothing unless nothing was configured.
    //
    // With no allowlist there is no static base URL to derive a trusted origin
    // from, so it is computed per request from the host the request arrived on. A
    // function rather than an array because Better Auth resolves the array form
    // once at startup; only the function form is re-evaluated per request.
    //
    // The CSRF property survives: the trusted set is exactly the request's own
    // origin, so a cross-site POST carrying a victim's cookie still arrives with a
    // foreign `Origin` and is rejected. Browsers cannot forge `Host`.
    trustedOrigins: (request?: Request) => {
      if (!request || runtime.origins.mode !== "inferred") return [];
      const origin = originFromRequest(request, runtime.trustProxyHeaders);
      return origin ? [origin] : [];
    },
    secret: runtime.secret,
    advanced: {
      // Honour x-forwarded-host only when an operator has declared a proxy in
      // front. The allowlist is still what constrains the value.
      trustedProxyHeaders: runtime.trustProxyHeaders,
      // `useSecureCookies` is deliberately not set. Better Auth resolves it per
      // request from the scheme the request actually arrived on, falling back to
      // the base URL and then to NODE_ENV. Passing a value computed from the
      // allowlist overrode all three, and in `inferred` mode — nothing configured,
      // which is a supported production shape — it resolved to `false`, stripping
      // `Secure` and the `__Secure-` prefix from session cookies on an HTTPS
      // deployment. Per-request resolution is also simply more accurate: an https
      // request gets a Secure cookie and a plaintext one does not, rather than the
      // whole deployment following whichever origin in the list is weakest.
    },
    database: prismaAdapter(prisma, { provider: "sqlite" }),
    emailAndPassword: {
      enabled: passwordAuthenticationEnabled(runtime.mode),
      requireEmailVerification: false,
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    databaseHooks: authDatabaseHooks,
    plugins: [
      managementAdminPlugin(),
      apiKey({
        defaultPrefix: "aide_",
        requireName: true,
        startingCharactersConfig: {
          shouldStore: true,
          charactersLength: 12,
        },
        keyExpiration: {
          defaultExpiresIn: null,
          disableCustomExpiresTime: false,
          minExpiresIn: 1,
          maxExpiresIn: 3650,
        },
        rateLimit: { enabled: false },
        enableSessionForAPIKeys: false,
      }),
      bearer(),
      oneTimeToken({
        disableClientRequest: true,
        expiresIn: 1,
        storeToken: "hashed",
      }),
      ...(oauthPlugin ? [oauthPlugin] : []),
      nextCookies(),
    ],
  });
}

export type AideAuth = ReturnType<typeof createAuth>;

let authPromise: Promise<AideAuth> | null = null;

export function getAuth(): Promise<AideAuth> {
  if (!authPromise) {
    authPromise = getPrismaClient().then((prisma) => createAuth(prisma));
  }
  return authPromise;
}

export function resetAuthForTests(): void {
  if (process.env.NODE_ENV === "test") authPromise = null;
}
