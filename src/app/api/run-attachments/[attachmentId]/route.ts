import { runAttachmentResponse } from "@/services/runs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const { attachmentId } = await context.params;
  return runAttachmentResponse(attachmentId);
}
