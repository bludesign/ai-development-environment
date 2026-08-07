import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createMobileAuthorizationCode: vi.fn(),
  getSession: vi.fn(),
  generateOneTimeToken: vi.fn(),
  getAuthRuntimeConfig: vi.fn(),
}));

vi.mock("@/services/auth", () => ({
  getAuth: async () => ({
    api: {
      getSession: mocks.getSession,
      generateOneTimeToken: mocks.generateOneTimeToken,
    },
  }),
  getAuthRuntimeConfig: mocks.getAuthRuntimeConfig,
}));

vi.mock("../../pkce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pkce")>()),
  createMobileAuthorizationCode: mocks.createMobileAuthorizationCode,
}));

import { MOBILE_OAUTH_STATE_COOKIE } from "../state";
import { GET } from "./route";

const CALLBACK = "aide-auth://callback";
const BROWSER_STATE = "b".repeat(43);
const CLIENT_STATE = "s".repeat(43);
const CODE_CHALLENGE = "c".repeat(43);

function request({
  browserState,
  cookieState,
  clientState = CLIENT_STATE,
  codeChallenge = CODE_CHALLENGE,
  providerError,
}: {
  browserState?: string;
  cookieState?: string;
  clientState?: string;
  codeChallenge?: string;
  providerError?: string;
} = {}): Request {
  const url = new URL(
    "https://control.example.com/api/auth/mobile/oauth/complete",
  );
  url.searchParams.set("callback", CALLBACK);
  url.searchParams.set("state", clientState);
  url.searchParams.set("code_challenge", codeChallenge);
  if (browserState !== undefined) {
    url.searchParams.set("browser_state", browserState);
  }
  if (providerError !== undefined) url.searchParams.set("error", providerError);
  return new Request(url, {
    headers: {
      cookie: [
        "better-auth.session_token=session-value",
        cookieState !== undefined
          ? `${MOBILE_OAUTH_STATE_COOKIE}=${cookieState}`
          : null,
      ]
        .filter(Boolean)
        .join("; "),
    },
  });
}

function location(response: Response): URL {
  return new URL(response.headers.get("location")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthRuntimeConfig.mockReturnValue({ trustProxyHeaders: false });
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.generateOneTimeToken.mockResolvedValue({ token: "one-time-token" });
  mocks.createMobileAuthorizationCode.mockResolvedValue("a".repeat(43));
});

describe("mobile OAuth completion", () => {
  test("hands the app a PKCE-bound code when the browser state matches", async () => {
    const response = await GET(
      request({ browserState: BROWSER_STATE, cookieState: BROWSER_STATE }),
    );

    expect(response.status).toBe(302);
    expect(location(response).searchParams.get("code")).toBe("a".repeat(43));
    expect(location(response).searchParams.get("state")).toBe(CLIENT_STATE);
    expect(location(response).searchParams.get("token")).toBeNull();
    expect(location(response).toString()).not.toContain("one-time-token");
    expect(mocks.createMobileAuthorizationCode).toHaveBeenCalledWith(
      "one-time-token",
      CODE_CHALLENGE,
    );
    // The state is single-use, so the cookie is retired on the way out.
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test.each([
    ["no state at all", {}],
    ["a state with no cookie behind it", { browserState: BROWSER_STATE }],
    ["a cookie with no state on the URL", { cookieState: BROWSER_STATE }],
    [
      "a state that does not match the cookie",
      { browserState: "f".repeat(43), cookieState: BROWSER_STATE },
    ],
  ])("refuses %s without minting a token", async (_label, options) => {
    const response = await GET(request(options));

    expect(location(response).searchParams.get("error")).toBe("invalid_state");
    expect(location(response).searchParams.get("state")).toBe(CLIENT_STATE);
    expect(location(response).searchParams.get("token")).toBeNull();
    // The check has to come first: a cross-site navigation carries the session
    // cookie, so resolving the session before the state would be the whole bug.
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.createMobileAuthorizationCode).not.toHaveBeenCalled();
  });

  test("reports a failed sign-in separately from a bad state", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await GET(
      request({ browserState: BROWSER_STATE, cookieState: BROWSER_STATE }),
    );

    expect(location(response).searchParams.get("error")).toBe(
      "authentication_failed",
    );
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
  });

  test("sanitizes provider errors without resolving the browser session", async () => {
    const response = await GET(
      request({
        browserState: BROWSER_STATE,
        cookieState: BROWSER_STATE,
        providerError: "provider_secret_internal_reason",
      }),
    );

    const callback = location(response);
    expect(callback.searchParams.get("error")).toBe("authentication_failed");
    expect(callback.toString()).not.toContain(
      "provider_secret_internal_reason",
    );
    expect(callback.searchParams.get("state")).toBe(CLIENT_STATE);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  test("does not create a code when the signed client parameters are malformed", async () => {
    const response = await GET(
      request({
        browserState: BROWSER_STATE,
        cookieState: BROWSER_STATE,
        codeChallenge: "short",
      }),
    );

    expect(location(response).searchParams.get("error")).toBe(
      "invalid_request",
    );
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.createMobileAuthorizationCode).not.toHaveBeenCalled();
  });

  test("returns a sanitized server error when code storage fails", async () => {
    mocks.createMobileAuthorizationCode.mockRejectedValue(
      new Error("database"),
    );

    const response = await GET(
      request({ browserState: BROWSER_STATE, cookieState: BROWSER_STATE }),
    );

    expect(location(response).searchParams.get("error")).toBe("server_error");
    expect(location(response).searchParams.get("state")).toBe(CLIENT_STATE);
  });

  test("rejects a callback that is not the registered scheme", async () => {
    const url = new URL(
      "https://control.example.com/api/auth/mobile/oauth/complete",
    );
    url.searchParams.set("callback", "https://evil.test/steal");
    url.searchParams.set("browser_state", BROWSER_STATE);
    url.searchParams.set("state", CLIENT_STATE);
    url.searchParams.set("code_challenge", CODE_CHALLENGE);

    const response = await GET(new Request(url));

    expect(response.status).toBe(400);
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
  });
});
