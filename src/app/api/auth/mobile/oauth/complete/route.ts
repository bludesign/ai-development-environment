import { getAuth, getAuthRuntimeConfig } from "@/services/auth";

import {
  createMobileAuthorizationCode,
  isMobileOAuthState,
  isPKCECodeChallenge,
} from "../../pkce";
import {
  clearedMobileOAuthStateCookie,
  readMobileOAuthState,
  stateMatches,
} from "../state";

function redirectTo(url: URL, clearedCookie: string): Response {
  // `Response.redirect` produces immutable headers, which cannot carry the cookie
  // that retires the state.
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: url.toString(),
      pragma: "no-cache",
      "set-cookie": clearedCookie,
    },
  });
}

function failedCallback(
  callback: string,
  error: string,
  description: string,
  clientState: string | null,
  clearedCookie: string,
): Response {
  const failed = new URL(callback);
  failed.searchParams.set("error", error);
  failed.searchParams.set("error_description", description);
  if (isMobileOAuthState(clientState)) {
    failed.searchParams.set("state", clientState);
  }
  return redirectTo(failed, clearedCookie);
}

export async function GET(request: Request): Promise<Response> {
  const requestURL = new URL(request.url);
  const callback = requestURL.searchParams.get("callback");
  if (callback !== "aide-auth://callback") {
    return Response.json(
      {
        error: {
          code: "INVALID_CALLBACK",
          message: "Invalid mobile callback.",
        },
      },
      { status: 400 },
    );
  }

  const runtime = getAuthRuntimeConfig();
  const cleared = clearedMobileOAuthStateCookie(
    request,
    runtime.trustProxyHeaders,
  );

  const clientState = requestURL.searchParams.get("state");
  const codeChallenge = requestURL.searchParams.get("code_challenge");
  if (!isMobileOAuthState(clientState) || !isPKCECodeChallenge(codeChallenge)) {
    return failedCallback(
      callback,
      "invalid_request",
      "The mobile authentication request is invalid.",
      clientState,
      cleared,
    );
  }

  // Trading an ambient session for a native authorization code is exactly the
  // kind of request `SameSite=Lax` still permits cross-site, so it is refused
  // unless it carries the state this server planted at `start`. The state is
  // retired either way, so a leaked one cannot be replayed.
  if (
    !stateMatches(
      readMobileOAuthState(request.headers),
      requestURL.searchParams.get("browser_state"),
    )
  ) {
    return failedCallback(
      callback,
      "invalid_state",
      "The browser authentication state is invalid or expired.",
      clientState,
      cleared,
    );
  }

  if (requestURL.searchParams.has("error")) {
    return failedCallback(
      callback,
      "authentication_failed",
      "The identity provider did not complete sign-in.",
      clientState,
      cleared,
    );
  }

  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return failedCallback(
        callback,
        "authentication_failed",
        "The identity provider did not create a session.",
        clientState,
        cleared,
      );
    }
    const { token } = await auth.api.generateOneTimeToken({
      headers: request.headers,
    });
    const code = await createMobileAuthorizationCode(token, codeChallenge);
    const destination = new URL(callback);
    destination.searchParams.set("code", code);
    destination.searchParams.set("state", clientState);
    return redirectTo(destination, cleared);
  } catch {
    return failedCallback(
      callback,
      "server_error",
      "The server could not complete mobile authentication.",
      clientState,
      cleared,
    );
  }
}
