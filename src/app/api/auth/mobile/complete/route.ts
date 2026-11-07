import { getAuth, getAuthRuntimeConfig } from "@/services/auth";

import {
  clearedNearbyStateCookie,
  readNearbyState,
  stateMatches,
} from "../nearby-state";
import {
  createTelevisionAuthorizationCode,
  isMobileOAuthState,
  isPKCECodeChallenge,
} from "../pkce";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const callback = url.searchParams.get("callback");
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
  const cleared = clearedNearbyStateCookie(request, runtime.trustProxyHeaders);
  const clientState = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  const destination = new URL(callback);
  if (isMobileOAuthState(clientState))
    destination.searchParams.set("state", clientState);

  function respond(error?: string, description?: string): Response {
    if (error) destination.searchParams.set("error", error);
    if (description)
      destination.searchParams.set("error_description", description);
    return new Response(null, {
      status: 302,
      headers: {
        location: destination.toString(),
        "set-cookie": cleared,
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    });
  }
  if (!isMobileOAuthState(clientState) || !isPKCECodeChallenge(challenge)) {
    return respond(
      "invalid_request",
      "The mobile authentication request is invalid.",
    );
  }
  if (
    !stateMatches(
      readNearbyState(request.headers),
      url.searchParams.get("browser_state"),
    )
  ) {
    return respond(
      "invalid_state",
      "The browser authentication state is invalid or expired.",
    );
  }
  if (url.searchParams.has("error")) {
    return respond("authentication_failed", "Sign-in did not complete.");
  }
  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session)
      return respond(
        "authentication_failed",
        "Sign-in did not create a session.",
      );
    const { token } = await auth.api.generateOneTimeToken({
      headers: request.headers,
    });
    const code = await createTelevisionAuthorizationCode(token, challenge);
    destination.searchParams.set("code", code);
    return respond();
  } catch {
    return respond(
      "server_error",
      "The server could not complete mobile authentication.",
    );
  }
}
