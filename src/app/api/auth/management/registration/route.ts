import * as z from "zod/v4";

import { getRegistrationStatus, setRegistrationEnabled } from "@/services/auth";

import { authenticated } from "../http";

const updateSchema = z.object({ enabled: z.boolean() });

export async function GET(request: Request): Promise<Response> {
  return authenticated(request, async () => getRegistrationStatus());
}

export async function PATCH(request: Request): Promise<Response> {
  return authenticated(request, async () => {
    const input = updateSchema.parse(await request.json());
    await setRegistrationEnabled(input.enabled);
    return getRegistrationStatus();
  });
}
