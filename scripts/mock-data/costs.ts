import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesFromNow } from "./time";

/**
 * Usage/cost aggregates. Per-run token usage is seeded with the runs; these rows drive the
 * sidebar summary and the ccusage collection surfaced on the Usage page.
 */
export async function seedCosts(prisma: PrismaClient): Promise<void> {
  await prisma.sidebarUsageSummary.createMany({
    data: [
      {
        id: "sidebar-usage-day",
        period: "DAY",
        totalCost: 4.87,
        collectedAt: hoursAgo(1),
      },
      {
        id: "sidebar-usage-week",
        period: "WEEK",
        totalCost: 38.42,
        collectedAt: hoursAgo(1),
      },
      {
        id: "sidebar-usage-month",
        period: "MONTH",
        totalCost: 162.15,
        collectedAt: hoursAgo(1),
      },
    ],
  });

  await prisma.ccusageCollection.create({
    data: {
      id: "ccusage-collection-latest",
      deadlineAt: minutesFromNow(2),
      finishedAt: hoursAgo(6),
      createdAt: hoursAgo(6),
      agents: {
        create: [
          {
            agentId: ids.agents.studio,
            initialStatus: "ONLINE",
          },
          {
            agentId: ids.agents.build,
            initialStatus: "ONLINE",
          },
        ],
      },
    },
  });
}
