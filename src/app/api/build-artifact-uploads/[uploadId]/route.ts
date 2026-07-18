import { receiveArtifactTransfer } from "@/services/builds/artifact-transfer";
import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(
  request: Request,
  context: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const authentication = await SharedGraphQLServerService.createContext(
    request.headers,
  );
  if (!authentication.agentId) {
    return new Response("Agent authentication is required", { status: 401 });
  }
  try {
    const { uploadId } = await context.params;
    await receiveArtifactTransfer(uploadId, authentication.agentId, request);
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Build artifact upload failed:", error);
    return new Response(
      error instanceof Error ? error.message : "Artifact upload failed",
      { status: 409 },
    );
  }
}
