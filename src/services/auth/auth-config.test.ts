import { describe, expect, test } from "vitest";

import { getAuthRuntimeConfig } from "./auth-config";

const base = {
  NODE_ENV: "production",
  APP_SECRET: "zhDyTms26c9u15SUcFxkhS8S+dCRnouxjPbQMb/haB8=",
  APP_ORIGINS: "control.example.com",
};

describe("authentication environment configuration", () => {
  test("omitting APP_ORIGINS leaves the origin to each request", () => {
    const runtime = getAuthRuntimeConfig({ ...base, APP_ORIGINS: undefined });
    expect(runtime.origins.mode).toBe("inferred");
    expect(runtime.baseURL).toBeNull();
  });

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
      requireIssuerValidation: false,
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
      requireIssuerValidation: false,
    });
  });

  test("configures issuer validation and defaults it to false", () => {
    const environment = {
      ...base,
      AUTH_MODE: "oidc" as const,
      AUTH_OAUTH_PROVIDER_ID: "company",
      AUTH_OAUTH_PROVIDER_NAME: "Company SSO",
      AUTH_OAUTH_CLIENT_ID: "client-id",
      AUTH_OAUTH_CLIENT_SECRET: "client-secret",
      AUTH_OAUTH_SCOPES: "openid,profile,email",
      AUTH_OAUTH_DISCOVERY_URL:
        "https://identity.example.com/.well-known/openid-configuration",
      AUTH_OAUTH_ISSUER: "https://identity.example.com",
    };
    expect(getAuthRuntimeConfig(environment).provider).toMatchObject({
      requireIssuerValidation: false,
    });
    expect(
      getAuthRuntimeConfig({
        ...environment,
        AUTH_OAUTH_REQUIRE_ISSUER_VALIDATION: "true",
      }).provider,
    ).toMatchObject({ requireIssuerValidation: true });
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
    [{ ...base, APP_SECRET: "too-short" }],
    [{ ...base, APP_SECRET: undefined }],
    [{ ...base, APP_ORIGINS: "*.example.com" }],
    [{ ...base, TRUST_PROXY_HEADERS: "maybe" }],
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
        AUTH_OAUTH_REQUIRE_ISSUER_VALIDATION: "maybe",
      },
    ],
  ])("rejects invalid or partial settings", (environment) => {
    expect(() => getAuthRuntimeConfig(environment)).toThrow();
  });
});
