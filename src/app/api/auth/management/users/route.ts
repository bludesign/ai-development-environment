import * as z from "zod/v4";
import { APIError } from "better-auth/api";

import { getPrismaClient } from "@/data/prisma-client";
import {
  getAuth,
  getAuthRuntimeConfig,
  passwordAuthenticationEnabled,
} from "@/services/auth";

import { authenticated } from "../http";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.email(),
  password: z.string().min(8).max(128),
});

export async function GET(request: Request): Promise<Response> {
  return authenticated(request, async (principal) => {
    const prisma = await getPrismaClient();
    const search = new URL(request.url).searchParams.get("search")?.trim();
    const users = await prisma.user.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search } },
              { email: { contains: search } },
            ],
          }
        : undefined,
      orderBy: [{ name: "asc" }, { email: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        createdAt: true,
        updatedAt: true,
        accounts: { select: { providerId: true } },
        sessions: {
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            expiresAt: true,
            ipAddress: true,
            userAgent: true,
          },
        },
      },
    });
    return {
      currentUserId: principal.userId,
      users: users.map((user) => ({
        ...user,
        providers: [
          ...new Set(user.accounts.map((account) => account.providerId)),
        ],
        accounts: undefined,
      })),
    };
  });
}

export async function POST(request: Request): Promise<Response> {
  return authenticated(request, async () => {
    const runtime = getAuthRuntimeConfig();
    if (!passwordAuthenticationEnabled(runtime.mode)) {
      throw new APIError("BAD_REQUEST", {
        message: "Local account creation is unavailable in OIDC-only mode.",
      });
    }
    const input = createSchema.parse(await request.json());
    const auth = await getAuth();
    return auth.api.createUser({
      headers: request.headers,
      body: { ...input, role: "user" },
    });
  });
}
