import * as z from "zod/v4";

import { getAuth, redeemTelevisionOneTimeToken } from "@/services/auth";

import {
  consumeMobileAuthorizationCode,
  isPKCECodeVerifier,
  pkceChallengeMatches,
} from "../pkce";

const inputSchema = z.object({
  code: z.string().min(1),
  code_verifier: z.string().min(1),
});

function invalidAuthorizationCode(): Response {
  return Response.json(
    {
      error: {
        code: "INVALID_AUTHORIZATION_CODE",
        message: "The authorization code is invalid or expired.",
      },
    },
    {
      status: 400,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = inputSchema.parse(await request.json());
    const authorization = await consumeMobileAuthorizationCode(input.code);
    if (
      !authorization ||
      !isPKCECodeVerifier(input.code_verifier) ||
      !pkceChallengeMatches(input.code_verifier, authorization.codeChallenge)
    ) {
      return invalidAuthorizationCode();
    }
    const auth = await getAuth();
    const { session, user } =
      authorization.sessionPurpose === "television"
        ? await redeemTelevisionOneTimeToken(
            auth,
            authorization.oneTimeToken,
            request.headers.get("user-agent") ?? "AI Dev for Apple TV",
          )
        : await auth.api.verifyOneTimeToken({
            body: { token: authorization.oneTimeToken },
          });
    return Response.json(
      {
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image ?? null,
        },
      },
      {
        headers: {
          "cache-control": "no-store",
          pragma: "no-cache",
        },
      },
    );
  } catch {
    return invalidAuthorizationCode();
  }
}
