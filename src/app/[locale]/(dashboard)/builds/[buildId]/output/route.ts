import { buildRawOutput, rawOutputResponse } from "@/lib/raw-terminal-output";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ buildId: string }> },
): Promise<Response> {
  const { buildId } = await params;
  const output = await buildRawOutput(buildId);
  return rawOutputResponse(output, `build-${buildId}-output.txt`);
}
