import { completeBuildArtifactTransferUpload } from "@/services/builds/artifact-relay";
import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

export const runtime = "nodejs";
export const maxDuration = 1800;

export async function POST(
  request: Request,
  context: { params: Promise<{ transferId: string }> },
): Promise<Response> {
  const agentId = (
    await SharedGraphQLServerService.createContext(request.headers)
  ).agentId;
  if (!agentId)
    return new Response("Agent authentication is required", { status: 401 });
  try {
    const { transferId } = await context.params;
    const transfer = await completeBuildArtifactTransferUpload(
      transferId,
      agentId,
    );
    return Response.json({ id: transfer.id, status: transfer.status });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Artifact completion failed",
      {
        status: 409,
      },
    );
  }
}
