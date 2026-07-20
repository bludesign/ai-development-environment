import { ingestTelemetry } from "../ingestion";

export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return ingestTelemetry(request, "CONSOLE");
}
