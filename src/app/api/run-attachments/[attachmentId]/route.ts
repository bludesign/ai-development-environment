import { runAttachmentResponse } from "@/services/runs";
import { requireUserRequest } from "@/services/auth";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const authenticationError = await requireUserRequest(request);
  if (authenticationError) return authenticationError;
  const { attachmentId } = await context.params;
  return runAttachmentResponse(attachmentId);
}
