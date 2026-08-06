import { APIError } from "better-auth/api";
import * as z from "zod/v4";

import {
  crossOriginError,
  PrincipalResolutionError,
  principalErrorResponse,
  requireUserPrincipal,
} from "@/services/auth";

export async function authenticated<T>(
  request: Request,
  action: (
    principal: Awaited<ReturnType<typeof requireUserPrincipal>>,
  ) => Promise<T>,
): Promise<Response> {
  // These routes create accounts, reset passwords, and mint API keys on nothing
  // but a session cookie, so they are the ones a cross-site caller would most
  // like to reach.
  const crossOrigin = crossOriginError(request);
  if (crossOrigin) return crossOrigin;
  try {
    const principal = await requireUserPrincipal(request.headers);
    return Response.json(await action(principal));
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return principalErrorResponse(error);
    }
    if (error instanceof APIError) {
      return Response.json(
        { error: { code: error.status, message: error.message } },
        { status: error.statusCode },
      );
    }
    if (error instanceof SyntaxError) {
      return Response.json(
        { error: { code: "INVALID_JSON", message: "Invalid JSON body." } },
        { status: 400 },
      );
    }
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: z.prettifyError(error),
          },
        },
        { status: 400 },
      );
    }
    console.error("Auth management request failed:", error);
    return Response.json(
      {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "The request could not be completed.",
        },
      },
      { status: 500 },
    );
  }
}
