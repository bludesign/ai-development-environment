import { APIError } from "better-auth/api";
import * as z from "zod/v4";

import { getAuth } from "@/services/auth";

const inputSchema = z.object({ token: z.string().min(1) });

export async function POST(request: Request): Promise<Response> {
  try {
    const input = inputSchema.parse(await request.json());
    const auth = await getAuth();
    const result = await auth.api.verifyOneTimeToken({ body: input });
    return Response.json({
      token: result.session.token,
      expiresAt: result.session.expiresAt,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        image: result.user.image ?? null,
      },
    });
  } catch (error) {
    const message =
      error instanceof APIError
        ? error.message
        : "The token is invalid or expired.";
    return Response.json(
      { error: { code: "INVALID_ONE_TIME_TOKEN", message } },
      { status: 400 },
    );
  }
}
