import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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

import { MOBILE_OAUTH_STATE_COOKIE } from "../state";
import { GET } from "./route";

const CALLBACK = "aide-auth://callback";
const STATE = "a-state-this-server-planted";

function request({
  state,
  cookieState,
}: {
  state?: string;
  cookieState?: string;
} = {}): Request {
  const url = new URL(
    "https://control.example.com/api/auth/mobile/oauth/complete",
  );
  url.searchParams.set("callback", CALLBACK);
  if (state !== undefined) url.searchParams.set("state", state);
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
});

describe("mobile OAuth completion", () => {
  test("hands the app a one-time token when the state matches", async () => {
    const response = await GET(request({ state: STATE, cookieState: STATE }));

    expect(response.status).toBe(302);
    expect(location(response).searchParams.get("token")).toBe("one-time-token");
    // The state is single-use, so the cookie is retired on the way out.
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test.each([
    ["no state at all", {}],
    ["a state with no cookie behind it", { state: STATE }],
    ["a cookie with no state on the URL", { cookieState: STATE }],
    [
      "a state that does not match the cookie",
      { state: "forged", cookieState: STATE },
    ],
  ])("refuses %s without minting a token", async (_label, options) => {
    const response = await GET(request(options));

    expect(location(response).searchParams.get("error")).toBe("invalid_state");
    expect(location(response).searchParams.get("token")).toBeNull();
    // The check has to come first: a cross-site navigation carries the session
    // cookie, so resolving the session before the state would be the whole bug.
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  test("reports a failed sign-in separately from a bad state", async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await GET(request({ state: STATE, cookieState: STATE }));

    expect(location(response).searchParams.get("error")).toBe(
      "authentication_failed",
    );
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
  });

  test("rejects a callback that is not the registered scheme", async () => {
    const url = new URL(
      "https://control.example.com/api/auth/mobile/oauth/complete",
    );
    url.searchParams.set("callback", "https://evil.test/steal");
    url.searchParams.set("state", STATE);

    const response = await GET(new Request(url));

    expect(response.status).toBe(400);
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled();
  });
});
