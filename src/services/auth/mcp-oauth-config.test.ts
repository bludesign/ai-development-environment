import { describe, expect, test } from "vitest";
import { getMcpOAuthConfig } from "./mcp-oauth-config";

describe("MCP OAuth configuration", () => {
  test("is disabled independently of sign-in mode", () => {
    expect(getMcpOAuthConfig({ AUTH_MODE: "oidc" })).toBeNull();
    expect(
      getMcpOAuthConfig({ AUTH_MODE: "password", MCP_OAUTH_ENABLED: "false" }),
    ).toBeNull();
  });
  test("requires an explicit canonical identity and never uses request hosts", () => {
    expect(() => getMcpOAuthConfig({ MCP_OAUTH_ENABLED: "true" })).toThrow(
      "canonical",
    );
    expect(() =>
      getMcpOAuthConfig({
        MCP_OAUTH_ENABLED: "true",
        NODE_ENV: "development",
        APP_ORIGINS: "*.example.com",
      }),
    ).toThrow("canonical");
    expect(
      getMcpOAuthConfig({
        MCP_OAUTH_ENABLED: "true",
        PUBLIC_BASE_URL: "https://control.example",
      }),
    ).toEqual({
      origin: "https://control.example",
      issuer: "https://control.example/api/auth",
      resource: "https://control.example/api/mcp",
      dcrEnabled: false,
    });
  });
  test.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("allows loopback development at %s", (origin) => {
    expect(
      getMcpOAuthConfig({ MCP_OAUTH_ENABLED: "true", PUBLIC_BASE_URL: origin })
        ?.resource,
    ).toBe(`${origin}/api/mcp`);
  });
  test("rejects insecure public origins and malformed flags", () => {
    expect(() => getMcpOAuthConfig({ MCP_OAUTH_ENABLED: "yes" })).toThrow(
      "MCP_OAUTH_ENABLED",
    );
    expect(() =>
      getMcpOAuthConfig({
        MCP_OAUTH_ENABLED: "true",
        PUBLIC_BASE_URL: "http://example.com",
      }),
    ).toThrow();
    expect(() =>
      getMcpOAuthConfig({
        MCP_OAUTH_ENABLED: "true",
        PUBLIC_BASE_URL: "https://example.com",
        MCP_OAUTH_DCR_ENABLED: "yes",
      }),
    ).toThrow("MCP_OAUTH_DCR_ENABLED");
  });
});
