import { isTrustedOrigin, originFromRequest } from "@/lib/app-origins";
import {
  getAuth,
  getAuthRuntimeConfig,
  getRegistrationStatus,
} from "@/services/auth";

import { createNearbyState, nearbyStateCookie } from "../nearby-state";
import { isMobileOAuthState, isPKCECodeChallenge } from "../pkce";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const callback = url.searchParams.get("callback") ?? "aide-auth://callback";
  if (callback !== "aide-auth://callback") {
    return Response.json(
      {
        error: {
          code: "INVALID_CALLBACK",
          message: "The mobile callback must use aide-auth://callback.",
        },
      },
      { status: 400 },
    );
  }
  const clientState = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  if (
    !isMobileOAuthState(clientState) ||
    !isPKCECodeChallenge(codeChallenge) ||
    url.searchParams.get("code_challenge_method") !== "S256"
  ) {
    return Response.json(
      {
        error: {
          code: "INVALID_PKCE_REQUEST",
          message:
            "Mobile sign-in requires state, a valid code challenge, and code_challenge_method=S256.",
        },
      },
      { status: 400 },
    );
  }
  const runtime = getAuthRuntimeConfig();
  const requestOrigin =
    originFromRequest(request, runtime.trustProxyHeaders) ?? url.origin;
  // The state cookie and browser session must stay on the same trusted origin.
  if (!isTrustedOrigin(runtime.origins, requestOrigin)) {
    return Response.json(
      {
        error: {
          code: "UNTRUSTED_ORIGIN",
          message: "Use a configured server origin to sign in.",
        },
      },
      { status: 400 },
    );
  }
  const browserState = createNearbyState();
  const completion = new URL("/api/auth/mobile/complete", requestOrigin);
  completion.searchParams.set("callback", callback);
  completion.searchParams.set("state", clientState);
  completion.searchParams.set("code_challenge", codeChallenge);
  completion.searchParams.set("browser_state", browserState);

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  let destination = completion;
  if (!session) {
    const registration = await getRegistrationStatus();
    destination = new URL(
      registration.setupRequired ? "/register" : "/sign-in",
      requestOrigin,
    );
    destination.searchParams.set(
      "returnTo",
      `${completion.pathname}${completion.search}`,
    );
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: destination.toString(),
      "set-cookie": nearbyStateCookie(
        browserState,
        request,
        runtime.trustProxyHeaders,
      ),
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
