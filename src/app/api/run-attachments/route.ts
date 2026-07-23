import { storeRunAttachment } from "@/services/runs";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  try {
    const attachment = await storeRunAttachment(request);
    return Response.json({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      sha256: attachment.sha256,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}
