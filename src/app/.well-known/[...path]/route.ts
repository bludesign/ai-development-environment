import { getAuth } from "@/services/auth/auth";
import { getMcpOAuthConfig } from "@/services/auth/mcp-oauth-config";

export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  if (!getMcpOAuthConfig()) return new Response(null, { status: 404 });
  return (await getAuth()).handler(request);
}

export const GET = handle;
export const HEAD = handle;
