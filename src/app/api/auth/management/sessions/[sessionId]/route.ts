import { APIError } from "better-auth/api";

import { getPrismaClient } from "@/data/prisma-client";

import { authenticated } from "../../http";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  return authenticated(request, async () => {
    const { sessionId } = await context.params;
    const prisma = await getPrismaClient();
    const deleted = await prisma.session.deleteMany({
      where: { id: sessionId },
    });
    if (deleted.count !== 1) {
      throw new APIError("NOT_FOUND", { message: "Session not found." });
    }
    return { success: true };
  });
}
