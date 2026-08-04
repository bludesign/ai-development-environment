import { APIError } from "better-auth/api";
import * as z from "zod/v4";

import { getPrismaClient } from "@/data/prisma-client";

import { authenticated } from "../../http";

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "No changes supplied.");

export async function PATCH(
  request: Request,
  context: { params: Promise<{ keyId: string }> },
): Promise<Response> {
  return authenticated(request, async () => {
    const { keyId } = await context.params;
    const input = updateSchema.parse(await request.json());
    const prisma = await getPrismaClient();
    const updated = await prisma.apiKey.updateMany({
      where: { id: keyId },
      data: input,
    });
    if (updated.count !== 1) {
      throw new APIError("NOT_FOUND", { message: "API key not found." });
    }
    return { success: true };
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ keyId: string }> },
): Promise<Response> {
  return authenticated(request, async () => {
    const { keyId } = await context.params;
    const prisma = await getPrismaClient();
    const deleted = await prisma.apiKey.deleteMany({ where: { id: keyId } });
    if (deleted.count !== 1) {
      throw new APIError("NOT_FOUND", { message: "API key not found." });
    }
    return { success: true };
  });
}
