import { readBuildArtifactTransferRange } from "@/services/builds/artifact-relay";
import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

export const runtime = "nodejs";
export const maxDuration = 1800;

export async function GET(
  request: Request,
  context: { params: Promise<{ transferId: string }> },
): Promise<Response> {
  const agentId = (
    await SharedGraphQLServerService.createContext(request.headers)
  ).agentId;
  if (!agentId)
    return new Response("Agent authentication is required", { status: 401 });
  try {
    const range = request.headers.get("range");
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!match)
      return new Response("A bounded byte range is required", { status: 416 });
    const { transferId } = await context.params;
    const artifact = await readBuildArtifactTransferRange(
      transferId,
      agentId,
      Number(match[1]),
      Number(match[2]),
    );
    return new Response(artifact.bytes, {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Length": String(artifact.bytes.byteLength),
        "Content-Range": `bytes ${artifact.start}-${artifact.end}/${artifact.size}`,
        "Content-Type": artifact.contentType,
        "X-Artifact-Checksum": artifact.checksum ?? "",
        "X-Artifact-Filename": encodeURIComponent(artifact.filename),
      },
    });
  } catch (error) {
    return new Response(
      error instanceof Error ? error.message : "Artifact download failed",
      {
        status: 409,
      },
    );
  }
}
