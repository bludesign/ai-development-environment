import { prisma } from "@/data/prisma-client";

/**
 * Thin data-access layer injected into GraphQL resolver factories. It grows one method per
 * domain operation as models are added to the Prisma schema; for now it only exposes a
 * connectivity check used by the `health` query.
 */
export class PrismaService {
  async healthCheck(): Promise<boolean> {
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      return true;
    } catch (error) {
      console.error("Database health check failed:", error);
      return false;
    }
  }
}
