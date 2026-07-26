import {
  commandRunRawOutput,
  rawOutputResponse,
} from "@/lib/raw-terminal-output";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { runId } = await params;
  const output = await commandRunRawOutput(runId);
  return rawOutputResponse(output, `command-run-${runId}-output.txt`);
}
