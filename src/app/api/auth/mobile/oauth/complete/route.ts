import { getAuth } from "@/services/auth";

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
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    const failed = new URL(callback);
    failed.searchParams.set("error", "authentication_failed");
    return Response.redirect(failed, 302);
  }
  const { token } = await auth.api.generateOneTimeToken({
    headers: request.headers,
  });
  const destination = new URL(callback);
  destination.searchParams.set("token", token);
  return Response.redirect(destination, 302);
}
