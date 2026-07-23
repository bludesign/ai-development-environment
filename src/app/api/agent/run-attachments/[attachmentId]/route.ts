import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";
import { runAttachmentResponse } from "@/services/runs";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const authentication = await SharedGraphQLServerService.createContext(
    request.headers,
  );
  if (!authentication.agentId) {
    return new Response("Agent authentication is required", { status: 401 });
  }
  const { attachmentId } = await context.params;
  return runAttachmentResponse(attachmentId, authentication.agentId);
}
