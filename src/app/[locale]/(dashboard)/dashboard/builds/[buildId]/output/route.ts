import { buildRawOutput, rawOutputResponse } from "@/lib/raw-terminal-output";
import { requireUserRequest } from "@/services/auth";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ buildId: string }> },
): Promise<Response> {
  const authenticationError = await requireUserRequest(request);
  if (authenticationError) return authenticationError;
  const { buildId } = await params;
  const output = await buildRawOutput(buildId);
  return rawOutputResponse(output, `build-${buildId}-output.txt`);
}
