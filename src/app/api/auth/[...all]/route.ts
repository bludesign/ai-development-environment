import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/services/auth";

export const runtime = "nodejs";

async function handle(request: Request): Promise<Response> {
  const auth = await getAuth();
  return auth.handler(request);
}

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(handle);
