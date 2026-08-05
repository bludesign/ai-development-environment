import { getAuth, getAuthRuntimeConfig } from "@/services/auth";

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
    headers: { location: url.toString(), "set-cookie": clearedCookie },
  });
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

  // Trading an ambient session for a one-time token is exactly the kind of request
  // `SameSite=Lax` still permits cross-site, so it is refused unless it carries the
  // state this server planted at `start`. The state is retired either way, so a
  // leaked one cannot be replayed.
  if (
    !stateMatches(
      readMobileOAuthState(request.headers),
      requestURL.searchParams.get("state"),
    )
  ) {
    const failed = new URL(callback);
    failed.searchParams.set("error", "invalid_state");
    return redirectTo(failed, cleared);
  }

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const failed = new URL(callback);
    failed.searchParams.set("error", "authentication_failed");
    return redirectTo(failed, cleared);
  }
  const { token } = await auth.api.generateOneTimeToken({
    headers: request.headers,
  });
  const destination = new URL(callback);
  destination.searchParams.set("token", token);
  return redirectTo(destination, cleared);
}
