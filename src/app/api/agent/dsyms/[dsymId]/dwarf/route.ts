import {
  PrincipalResolutionError,
  resolveRequestPrincipal,
} from "@/services/auth";
import { fileResponse, jsonError } from "@/services/crashes/http";
import { getServerServices } from "@/services/server-services";

export const runtime = "nodejs";
export const maxDuration = 1800;

type Context = { params: Promise<{ dsymId: string }> };

async function dwarf(request: Request, context: Context) {
  const services = getServerServices();
  let agentId: string;
  try {
    const principal = await resolveRequestPrincipal(
      request.headers,
      services.agentControlService,
    );
    if (principal.kind !== "agent") {
      return jsonError(401, "AUTHENTICATION_REQUIRED", "An agent is required");
    }
    agentId = principal.agentId;
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return jsonError(error.status, "AUTHENTICATION_REQUIRED", error.message);
    }
    throw error;
  }
  const { dsymId } = await context.params;
  const file = await services.crashesService.agentDwarfFile(agentId, dsymId);
  if (!file) {
    return jsonError(
      403,
      "FORBIDDEN",
      "No active symbolication job of this agent needs that dSYM",
    );
  }
  const response = await fileResponse(request, {
    path: file.path,
    filename: file.filename,
    contentType: "application/octet-stream",
    expectedSize: file.size,
  });
  response.headers.set("x-content-sha256", file.sha256);
  return response;
}

/** Serves one DWARF file to the agent symbolicating a crash, with ranges. */
export function GET(request: Request, context: Context): Promise<Response> {
  return dwarf(request, context);
}

export async function HEAD(
  request: Request,
  context: Context,
): Promise<Response> {
  const response = await dwarf(request, context);
  await response.body?.cancel();
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
