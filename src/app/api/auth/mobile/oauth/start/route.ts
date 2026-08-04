import { APIError } from "better-auth/api";

import {
  getAuth,
  getAuthRuntimeConfig,
  oauthAuthenticationEnabled,
} from "@/services/auth";

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
  const callback = mobileCallback(
    new URL(request.url).searchParams.get("callback"),
  );
  const completion = new URL(
    "/api/auth/mobile/oauth/complete",
    runtime.baseURL,
  );
  completion.searchParams.set("callback", callback);

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
  const redirect = Response.redirect(result.url, 302);
  for (const cookie of response.headers.getSetCookie()) {
    redirect.headers.append("set-cookie", cookie);
  }
  return redirect;
}
