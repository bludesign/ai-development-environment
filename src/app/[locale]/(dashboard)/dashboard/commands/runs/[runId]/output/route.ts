import {
  commandRunRawOutput,
  rawOutputResponse,
} from "@/lib/raw-terminal-output";
import { requireUserRequest } from "@/services/auth";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const authenticationError = await requireUserRequest(request);
  if (authenticationError) return authenticationError;
  const { runId } = await params;
  const output = await commandRunRawOutput(runId);
  return rawOutputResponse(output, `command-run-${runId}-output.txt`);
}
