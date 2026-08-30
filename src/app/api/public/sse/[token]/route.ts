import { getServerServices } from "@/services/server-services";
import {
  handlePublicSseRequest,
  sseOptionsResponse,
} from "@/services/sse/sse-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 86_400;

async function handle(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const service = getServerServices().sseService;
  const endpoint = await service.snapshotForToken(token);
  if (!endpoint) {
    return Response.json(
      { error: "SSE endpoint not found" },
      {
        status: 404,
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      },
    );
  }
  return handlePublicSseRequest(service, endpoint, request);
}

export function OPTIONS(): Response {
  return sseOptionsResponse();
}

export function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handle(request, context);
}

export function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  return handle(request, context);
}
