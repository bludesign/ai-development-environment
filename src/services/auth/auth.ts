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

import { getPrismaClient } from "@/data/prisma-client";

import {
  getAuthRuntimeConfig,
  oauthAuthenticationEnabled,
  passwordAuthenticationEnabled,
} from "./auth-config";
import { authDatabaseHooks } from "./registration";

const managementStatements = {
  user: [
    "create",
    "list",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
} as const;
const managementAccess = createAccessControl(managementStatements);
const userManagerRole = managementAccess.newRole(managementStatements);

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
              requireIssuerValidation: true,
              disableImplicitSignUp: false,
            },
          ],
        })
      : null;

  return betterAuth({
    appName: "AI Development Environment",
    baseURL: runtime.baseURL,
    secret: runtime.secret,
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
      admin({
        ac: managementAccess,
        roles: { user: userManagerRole },
        defaultRole: "user",
        adminRoles: ["user"],
      }),
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
