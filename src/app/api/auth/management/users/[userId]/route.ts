import { APIError } from "better-auth/api";
import * as z from "zod/v4";

import {
  deleteManagedUser,
  getAuth,
  getAuthRuntimeConfig,
  passwordAuthenticationEnabled,
} from "@/services/auth";

import { authenticated } from "../../http";

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.email().optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "No changes supplied.");

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  return authenticated(request, async () => {
    const { userId } = await context.params;
    const input = updateSchema.parse(await request.json());
    const auth = await getAuth();
    if (input.name !== undefined || input.email !== undefined) {
      await auth.api.adminUpdateUser({
        headers: request.headers,
        body: {
          userId,
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
          },
        },
      });
    }
    if (input.password !== undefined) {
      if (!passwordAuthenticationEnabled(getAuthRuntimeConfig().mode)) {
        throw new APIError("BAD_REQUEST", {
          message: "Passwords are unavailable in OIDC-only mode.",
        });
      }
      await auth.api.setUserPassword({
        headers: request.headers,
        body: { userId, newPassword: input.password },
      });
    }
    return { success: true };
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  return authenticated(request, async (principal) => {
    const { userId } = await context.params;
    await deleteManagedUser(userId, principal.userId);
    return { success: true };
  });
}
