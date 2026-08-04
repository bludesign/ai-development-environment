import { APIError } from "better-auth/api";
import * as z from "zod/v4";

import { getPrismaClient } from "@/data/prisma-client";
import { getAuth } from "@/services/auth";

import { authenticated } from "../http";

const createSchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  expiresAt: z.iso.datetime().nullable().optional(),
});

export async function GET(request: Request): Promise<Response> {
  return authenticated(request, async () => {
    const prisma = await getPrismaClient();
    const keys = await prisma.apiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        start: true,
        prefix: true,
        referenceId: true,
        enabled: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        lastRequest: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });
    return { apiKeys: keys };
  });
}

export async function POST(request: Request): Promise<Response> {
  return authenticated(request, async () => {
    const input = createSchema.parse(await request.json());
    const prisma = await getPrismaClient();
    if (!(await prisma.user.findUnique({ where: { id: input.userId } }))) {
      throw new APIError("NOT_FOUND", { message: "User not found." });
    }
    let expiresIn: number | null = null;
    if (input.expiresAt) {
      expiresIn = Math.floor(
        (new Date(input.expiresAt).getTime() - Date.now()) / 1000,
      );
      if (expiresIn < 24 * 60 * 60) {
        throw new APIError("BAD_REQUEST", {
          message: "API-key expiration must be at least one day from now.",
        });
      }
    }
    const auth = await getAuth();
    const created = await auth.api.createApiKey({
      headers: request.headers,
      body: {
        userId: input.userId,
        name: input.name,
        expiresIn,
      },
    });
    return { apiKey: created };
  });
}
