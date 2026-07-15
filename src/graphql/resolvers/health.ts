import type { PrismaService } from "@/services/prisma";

// Resolver factory: receives its dependencies (the PrismaService) at schema-build time and
// closes over them, mirroring the processor project's dependency-injection pattern. Add one
// factory per domain and merge them in src/graphql/schema.ts.
export const createHealthResolvers = (prismaService: PrismaService) => ({
  Query: {
    health: async (): Promise<string> => {
      const healthy = await prismaService.healthCheck();
      return healthy ? "ok" : "degraded";
    },
  },
});
