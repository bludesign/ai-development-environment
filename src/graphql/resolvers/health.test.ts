// @vitest-environment node
import { expect, test } from "vitest";

import type { PrismaService } from "@/services/prisma";

import { createHealthResolvers } from "./health";

const stubService = (healthy: boolean) =>
  ({ healthCheck: async () => healthy }) as unknown as PrismaService;

test("health resolver returns 'ok' when the database is reachable", async () => {
  const resolvers = createHealthResolvers(stubService(true));
  await expect(resolvers.Query.health()).resolves.toBe("ok");
});

test("health resolver returns 'degraded' when the database is unreachable", async () => {
  const resolvers = createHealthResolvers(stubService(false));
  await expect(resolvers.Query.health()).resolves.toBe("degraded");
});
