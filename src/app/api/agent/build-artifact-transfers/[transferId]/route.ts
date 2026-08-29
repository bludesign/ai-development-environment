import {
  buildArtifactTransferStatus,
  initializeBuildArtifactTransfer,
} from "@/services/builds/artifact-relay";
import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

export const runtime = "nodejs";

async function authenticatedAgent(request: Request): Promise<string | null> {
  const authentication = await SharedGraphQLServerService.createContext(
    request.headers,
  );
  return authentication.agentId;
}

function transferJson(
  transfer: Awaited<ReturnType<typeof buildArtifactTransferStatus>>,
) {
  return {
    id: transfer.id,
    status: transfer.status,
    uploadOffset: transfer.uploadOffset,
    uploadLength: transfer.uploadLength,
    downloadOffset: transfer.downloadOffset,
    checksum: transfer.checksum,
    filename: transfer.filename,
    contentType: transfer.contentType,
    error: transfer.error,
    expiresAt: transfer.expiresAt.toISOString(),
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ transferId: string }> },
): Promise<Response> {
  const agentId = await authenticatedAgent(request);
  if (!agentId)
    return new Response("Agent authentication is required", { status: 401 });
  try {
    const { transferId } = await context.params;
    return Response.json(
      transferJson(await buildArtifactTransferStatus(transferId, agentId)),
    );
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Transfer unavailable",
      {
        status: 409,
      },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ transferId: string }> },
): Promise<Response> {
  const agentId = await authenticatedAgent(request);
  if (!agentId)
    return new Response("Agent authentication is required", { status: 401 });
  try {
    const { transferId } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const transfer = await initializeBuildArtifactTransfer(
      transferId,
      agentId,
      {
        uploadLength: Number(body.uploadLength),
        checksum: String(body.checksum ?? ""),
        filename: String(body.filename ?? ""),
        contentType: String(body.contentType ?? "application/octet-stream"),
      },
    );
    return Response.json(transferJson(transfer));
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Transfer initialization failed",
      {
        status: 409,
      },
    );
  }
}
