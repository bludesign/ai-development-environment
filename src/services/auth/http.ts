import "server-only";

import {
  PrincipalResolutionError,
  principalErrorResponse,
  requireUserPrincipal,
} from "./principal";

export async function requireUserRequest(
  request: Request,
): Promise<Response | null> {
  try {
    await requireUserPrincipal(request.headers);
    return null;
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return principalErrorResponse(error);
    }
    throw error;
  }
}
