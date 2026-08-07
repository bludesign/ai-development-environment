import { APIError } from "better-auth/api";

import { isTrustedOrigin, originFromRequest } from "@/lib/app-origins";
import {
  getAuth,
  getAuthRuntimeConfig,
  oauthAuthenticationEnabled,
} from "@/services/auth";

import { isMobileOAuthState, isPKCECodeChallenge } from "../../pkce";
import { createMobileOAuthState, mobileOAuthStateCookie } from "../state";

function mobileCallback(value: string | null): string {
  if (!value) return "aide-auth://callback";
  const url = new URL(value);
  if (url.protocol !== "aide-auth:" || url.host !== "callback") {
    throw new APIError("BAD_REQUEST", {
      message: "The mobile callback must use aide-auth://callback.",
    });
  }
  return "aide-auth://callback";
}

export async function GET(request: Request): Promise<Response> {
  const runtime = getAuthRuntimeConfig();
  if (!oauthAuthenticationEnabled(runtime.mode) || !runtime.provider) {
    return Response.json(
      { error: { code: "OAUTH_DISABLED", message: "OIDC is not enabled." } },
      { status: 404 },
    );
  }
  const requestURL = new URL(request.url);
  let callback: string;
  try {
    callback = mobileCallback(requestURL.searchParams.get("callback"));
  } catch {
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
  const clientState = requestURL.searchParams.get("state");
  const codeChallenge = requestURL.searchParams.get("code_challenge");
  const codeChallengeMethod = requestURL.searchParams.get(
    "code_challenge_method",
  );
  if (
    !isMobileOAuthState(clientState) ||
    !isPKCECodeChallenge(codeChallenge) ||
    codeChallengeMethod !== "S256"
  ) {
    return Response.json(
      {
        error: {
          code: "INVALID_PKCE_REQUEST",
          message:
            "Mobile OAuth requires state, a valid code challenge, and code_challenge_method=S256.",
        },
      },
      { status: 400 },
    );
  }
  // Complete the flow on whichever trusted origin the device actually reached, so
  // a phone on the tailnet is not bounced to the canonical origin mid-sign-in.
  // With nothing configured there is no canonical origin, and the request's own
  // is all there is.
  const requestOrigin =
    originFromRequest(request, runtime.trustProxyHeaders) ??
    new URL(request.url).origin;
  const completion = new URL(
    "/api/auth/mobile/oauth/complete",
    isTrustedOrigin(runtime.origins, requestOrigin)
      ? requestOrigin
      : (runtime.baseURL ?? requestOrigin),
  );
  completion.searchParams.set("callback", callback);
  // Planted here and required by `complete`, so only a flow that started at this
  // endpoint can trade a browser session for a native authorization code.
  const state = createMobileOAuthState();
  completion.searchParams.set("browser_state", state);
  completion.searchParams.set("state", clientState);
  completion.searchParams.set("code_challenge", codeChallenge);

  const auth = await getAuth();
  const response = await auth.api.signInWithOAuth2({
    headers: request.headers,
    body: {
      providerId: runtime.provider.providerId,
      callbackURL: completion.toString(),
      errorCallbackURL: completion.toString(),
    },
    asResponse: true,
  });
  const result = (await response.clone().json()) as { url?: string };
  if (!result.url) return response;

  // Built with `new Response` rather than `Response.redirect`: the latter returns
  // a response whose headers are immutable, so appending Better Auth's PKCE
  // cookies to it throws and the flow could never complete.
  const redirect = new Response(null, {
    status: 302,
    headers: { location: result.url },
  });
  for (const cookie of response.headers.getSetCookie()) {
    redirect.headers.append("set-cookie", cookie);
  }
  redirect.headers.append(
    "set-cookie",
    mobileOAuthStateCookie(state, request, runtime.trustProxyHeaders),
  );
  return redirect;
}
