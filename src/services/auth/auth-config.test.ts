import { describe, expect, test } from "vitest";

import { getAuthRuntimeConfig } from "./auth-config";

const base = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "a-secure-auth-secret-that-is-long-enough",
  BETTER_AUTH_URL: "https://control.example.com/path-is-ignored",
};

describe("authentication environment configuration", () => {
  test("defaults to password authentication", () => {
    expect(getAuthRuntimeConfig(base)).toMatchObject({
      mode: "password",
      baseURL: "https://control.example.com",
      provider: null,
    });
  });

  test.each(["password", "oidc", "both"] as const)(
    "accepts the %s mode",
    (mode) => {
      const environment =
        mode === "password"
          ? { ...base, AUTH_MODE: mode }
          : {
              ...base,
              AUTH_MODE: mode,
              AUTH_OAUTH_PROVIDER_ID: "company",
              AUTH_OAUTH_PROVIDER_NAME: "Company SSO",
              AUTH_OAUTH_CLIENT_ID: "client-id",
              AUTH_OAUTH_CLIENT_SECRET: "client-secret",
              AUTH_OAUTH_SCOPES: "openid,profile,email",
              AUTH_OAUTH_DISCOVERY_URL:
                "https://identity.example.com/.well-known/openid-configuration",
              AUTH_OAUTH_ISSUER: "https://identity.example.com",
            };
      expect(getAuthRuntimeConfig(environment).mode).toBe(mode);
    },
  );

  test("builds a provider from a discovery document", () => {
    expect(
      getAuthRuntimeConfig({
        ...base,
        AUTH_MODE: "both",
        AUTH_OAUTH_PROVIDER_ID: "company",
        AUTH_OAUTH_PROVIDER_NAME: "Company SSO",
        AUTH_OAUTH_CLIENT_ID: "client-id",
        AUTH_OAUTH_CLIENT_SECRET: "client-secret",
        AUTH_OAUTH_SCOPES: "openid, profile, email",
        AUTH_OAUTH_DISCOVERY_URL:
          "https://identity.example.com/.well-known/openid-configuration",
        AUTH_OAUTH_ISSUER: "https://identity.example.com",
      }).provider,
    ).toEqual({
      providerId: "company",
      displayName: "Company SSO",
      clientId: "client-id",
      clientSecret: "client-secret",
      scopes: ["openid", "profile", "email"],
      discoveryUrl:
        "https://identity.example.com/.well-known/openid-configuration",
      issuer: "https://identity.example.com",
      authorizationUrl: undefined,
      tokenUrl: undefined,
      userInfoUrl: undefined,
    });
  });

  test("accepts only a complete explicit endpoint set", () => {
    const environment = {
      ...base,
      AUTH_MODE: "oidc",
      AUTH_OAUTH_PROVIDER_ID: "company",
      AUTH_OAUTH_PROVIDER_NAME: "Company SSO",
      AUTH_OAUTH_CLIENT_ID: "client-id",
      AUTH_OAUTH_CLIENT_SECRET: "client-secret",
      AUTH_OAUTH_SCOPES: "openid,profile,email",
      AUTH_OAUTH_AUTHORIZATION_URL: "https://identity.example.com/authorize",
      AUTH_OAUTH_TOKEN_URL: "https://identity.example.com/token",
      AUTH_OAUTH_USER_INFO_URL: "https://identity.example.com/userinfo",
      AUTH_OAUTH_ISSUER: "https://identity.example.com",
    };
    expect(getAuthRuntimeConfig(environment).provider).toMatchObject({
      authorizationUrl: environment.AUTH_OAUTH_AUTHORIZATION_URL,
      tokenUrl: environment.AUTH_OAUTH_TOKEN_URL,
      userInfoUrl: environment.AUTH_OAUTH_USER_INFO_URL,
    });
  });

  test.each([
    [{ ...base, AUTH_MODE: "invalid" }],
    [
      {
        ...base,
        AUTH_MODE: "oidc",
        AUTH_OAUTH_PROVIDER_ID: "company",
        AUTH_OAUTH_PROVIDER_NAME: "Company SSO",
        AUTH_OAUTH_CLIENT_ID: "client-id",
        AUTH_OAUTH_CLIENT_SECRET: "client-secret",
        AUTH_OAUTH_SCOPES: "openid,profile,email",
      },
    ],
    [
      {
        ...base,
        AUTH_MODE: "oidc",
        AUTH_OAUTH_CLIENT_ID: "client-id",
        AUTH_OAUTH_CLIENT_SECRET: "client-secret",
        AUTH_OAUTH_DISCOVERY_URL:
          "https://identity.example.com/.well-known/openid-configuration",
      },
    ],
    [
      {
        ...base,
        AUTH_MODE: "both",
        AUTH_OAUTH_PROVIDER_ID: "company",
        AUTH_OAUTH_PROVIDER_NAME: "Company SSO",
        AUTH_OAUTH_CLIENT_ID: "client-id",
        AUTH_OAUTH_CLIENT_SECRET: "client-secret",
        AUTH_OAUTH_SCOPES: "openid,profile,email",
        AUTH_OAUTH_AUTHORIZATION_URL: "https://identity.example.com/authorize",
      },
    ],
    [
      {
        ...base,
        AUTH_MODE: "oidc",
        AUTH_OAUTH_PROVIDER_ID: "company",
        AUTH_OAUTH_PROVIDER_NAME: "Company SSO",
        AUTH_OAUTH_CLIENT_ID: "client-id",
        AUTH_OAUTH_CLIENT_SECRET: "client-secret",
        AUTH_OAUTH_SCOPES: "openid,profile,email",
        AUTH_OAUTH_DISCOVERY_URL:
          "https://identity.example.com/.well-known/openid-configuration",
        AUTH_OAUTH_AUTHORIZATION_URL: "https://identity.example.com/authorize",
        AUTH_OAUTH_TOKEN_URL: "https://identity.example.com/token",
        AUTH_OAUTH_USER_INFO_URL: "https://identity.example.com/userinfo",
      },
    ],
    [
      {
        ...base,
        BETTER_AUTH_SECRET: "too-short",
      },
    ],
  ])("rejects invalid or partial settings", (environment) => {
    expect(() => getAuthRuntimeConfig(environment)).toThrow();
  });
});
