import { APIError } from "better-auth/api";
import * as z from "zod/v4";

import {
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
    throw error;
  }
}
