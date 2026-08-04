import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo } from "./time";

export async function seedApps(prisma: PrismaClient): Promise<void> {
  await prisma.app.createMany({
    data: [
      {
        id: ids.apps.customerPortal,
        name: "Customer Portal",
        normalizedName: "customer portal",
        description:
          "Customer-facing web experience backed by the Acme platform API.",
        createdAt: daysAgo(80),
      },
      {
        id: ids.apps.mobileSuite,
        name: "Mobile Suite",
        normalizedName: "mobile suite",
        description:
          "Native iOS product sharing the customer web authentication surface.",
        createdAt: daysAgo(60),
      },
    ],
  });
  await prisma.appRepository.createMany({
    data: [
      {
        appId: ids.apps.customerPortal,
        repositoryId: ids.repositories.web,
      },
      {
        appId: ids.apps.customerPortal,
        repositoryId: ids.repositories.api,
      },
      {
        appId: ids.apps.mobileSuite,
        repositoryId: ids.repositories.ios,
      },
      {
        appId: ids.apps.mobileSuite,
        repositoryId: ids.repositories.web,
      },
    ],
  });
}
