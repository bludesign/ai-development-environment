import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { dayKey, hoursAgo } from "./time";

/**
 * Per-model daily usage for one agent, as ccusage's `--json` output shapes it. Cost is derived
 * from the model prices seeded in settings.ts so the Costs page and the Usage page agree.
 */
const PRICES: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-sonnet-4.5": {
    input: 0.000003,
    output: 0.000015,
    cacheWrite: 0.00000375,
    cacheRead: 0.0000003,
  },
  "claude-opus-4.1": {
    input: 0.000015,
    output: 0.000075,
    cacheWrite: 0.00001875,
    cacheRead: 0.0000015,
  },
  "gpt-5-codex": {
    input: 0.00000125,
    output: 0.00001,
    cacheWrite: 0,
    cacheRead: 0.000000125,
  },
};

type Breakdown = {
  modelName: keyof typeof PRICES;
  /** input, output, cache-creation, cache-read — in thousands of tokens. */
  tokens: [number, number, number, number];
};

type AgentUsage = {
  agentId: string;
  agentName: string;
  hostname: string;
  /** ccusage sources, the CLI histories the report was assembled from. */
  sources: string[];
  /** One entry per day back from today; `null` skips a day for that agent. */
  days: Array<Breakdown[] | null>;
};

const AGENT_USAGE: AgentUsage[] = [
  {
    agentId: ids.agents.studio,
    agentName: "Studio Mac",
    hostname: "studio-mac.local",
    sources: ["claude", "codex"],
    days: [
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [21_200, 3_000, 4_900, 94_500],
        },
        { modelName: "gpt-5-codex", tokens: [9_600, 1_200, 0, 32_900] },
      ],
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [22_000, 2_900, 4_800, 91_800],
        },
        { modelName: "claude-opus-4.1", tokens: [3_300, 490, 910, 13_600] },
        { modelName: "gpt-5-codex", tokens: [9_000, 1_100, 0, 30_800] },
      ],
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [32_200, 4_500, 7_300, 141_300],
        },
        { modelName: "gpt-5-codex", tokens: [11_600, 1_500, 0, 39_400] },
      ],
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [18_200, 2_500, 4_100, 81_400],
        },
      ],
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [24_700, 3_400, 5_400, 104_200],
        },
        { modelName: "claude-opus-4.1", tokens: [4_200, 640, 1_200, 17_200] },
      ],
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [36_100, 4_900, 8_100, 152_000],
        },
        { modelName: "gpt-5-codex", tokens: [13_000, 1_700, 0, 44_300] },
      ],
      null,
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [25_400, 3_600, 5_800, 109_000],
        },
        { modelName: "gpt-5-codex", tokens: [8_800, 1_100, 0, 29_800] },
      ],
      [{ modelName: "claude-opus-4.1", tokens: [8_800, 1_300, 2_500, 36_100] }],
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [24_800, 3_500, 5_700, 106_200],
        },
      ],
    ],
  },
  {
    agentId: ids.agents.build,
    agentName: "Build Mac",
    hostname: "build-mac.local",
    sources: ["claude"],
    days: [
      [{ modelName: "claude-sonnet-4.5", tokens: [7_300, 980, 1_700, 31_800] }],
      [{ modelName: "claude-sonnet-4.5", tokens: [6_400, 850, 1_400, 27_600] }],
      null,
      [
        {
          modelName: "claude-sonnet-4.5",
          tokens: [11_300, 1_500, 2_500, 50_400],
        },
      ],
      [{ modelName: "claude-sonnet-4.5", tokens: [7_500, 980, 1_600, 32_000] }],
      null,
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [6_700, 940, 1_500, 29_000] }],
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [6_000, 830, 1_400, 26_300] }],
    ],
  },
  {
    agentId: ids.agents.ci,
    agentName: "CI Runner",
    hostname: "ci-runner.local",
    sources: ["claude"],
    days: [
      [{ modelName: "claude-sonnet-4.5", tokens: [3_100, 420, 700, 13_400] }],
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [2_700, 360, 620, 11_800] }],
      [{ modelName: "claude-sonnet-4.5", tokens: [4_400, 590, 980, 19_200] }],
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [3_600, 480, 810, 15_600] }],
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [2_900, 390, 660, 12_500] }],
      [{ modelName: "claude-sonnet-4.5", tokens: [3_300, 450, 740, 14_300] }],
      null,
    ],
  },
];

const K = 1_000;

/** Rounded to cents-of-a-cent, the precision ccusage itself emits. */
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

function entryFor(usage: AgentUsage, daysBack: number, models: Breakdown[]) {
  const modelBreakdowns = models.map(({ modelName, tokens }) => {
    const [input, output, cacheCreation, cacheRead] = tokens;
    const price = PRICES[modelName]!;
    return {
      modelName,
      inputTokens: input * K,
      outputTokens: output * K,
      cacheCreationTokens: cacheCreation * K,
      cacheReadTokens: cacheRead * K,
      cost: round(
        input * K * price.input +
          output * K * price.output +
          cacheCreation * K * price.cacheWrite +
          cacheRead * K * price.cacheRead,
      ),
    };
  });
  const total = (
    key:
      | "inputTokens"
      | "outputTokens"
      | "cacheCreationTokens"
      | "cacheReadTokens",
  ) => modelBreakdowns.reduce((sum, model) => sum + model[key], 0);
  const inputTokens = total("inputTokens");
  const outputTokens = total("outputTokens");
  const cacheCreationTokens = total("cacheCreationTokens");
  const cacheReadTokens = total("cacheReadTokens");
  return {
    agent: "all",
    period: dayKey(daysBack),
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens:
      inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    totalCost: round(
      modelBreakdowns.reduce((sum, model) => sum + model.cost, 0),
    ),
    metadata: { agents: usage.sources },
    modelBreakdowns,
    modelsUsed: modelBreakdowns.map((model) => model.modelName),
  };
}

function reportFor(usage: AgentUsage) {
  const daily = usage.days.flatMap((models, daysBack) =>
    models ? [entryFor(usage, daysBack, models)] : [],
  );
  const sum = (key: keyof (typeof daily)[number]) =>
    daily.reduce((total, entry) => total + (entry[key] as number), 0);
  return {
    daily,
    totals: {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      totalTokens: sum("totalTokens"),
      totalCost: round(sum("totalCost")),
    },
  };
}

/**
 * Usage/cost aggregates. Per-run token usage is seeded with the runs; these rows drive the
 * sidebar summary and the ccusage collection surfaced on the Usage page.
 */
export async function seedCosts(prisma: PrismaClient): Promise<void> {
  await prisma.sidebarUsageSummary.createMany({
    data: [
      // Kept in step with the ccusage days above: today's report totals about $258 and the
      // trailing week about $1,851, so these read as the same spend seen from the sidebar.
      {
        id: "sidebar-usage-day",
        period: "DAY",
        totalCost: 258.74,
        collectedAt: hoursAgo(1),
      },
      {
        id: "sidebar-usage-week",
        period: "WEEK",
        totalCost: 1854.6,
        collectedAt: hoursAgo(1),
      },
      {
        id: "sidebar-usage-month",
        period: "MONTH",
        totalCost: 7826.05,
        collectedAt: hoursAgo(1),
      },
    ],
  });

  /**
   * A *finished* collection under a fixed id. The Usage page always asks the control plane to
   * collect afresh under a client-generated request id and then blocks until every online
   * agent answers — with no agent connected that only resolves at the 150s deadline, which is
   * why the capture used to photograph the spinner. The `usage` route in playwright/routes.ts
   * pins `crypto.randomUUID` to this id, so `collectCcusage` finds this row already complete
   * and the first reconcile query returns real numbers. `finishedAt` also keeps the service's
   * startup restore pass from re-dispatching jobs for it.
   */
  await prisma.ccusageCollection.create({
    data: {
      id: ids.ccusageCollections.captured,
      deadlineAt: hoursAgo(6),
      finishedAt: hoursAgo(6),
      createdAt: hoursAgo(6),
      agents: {
        create: [
          // QUEUING is the "a job was dispatched for this agent" state; the job rows below
          // carry the reports that turn each member SUCCEEDED.
          { agentId: ids.agents.studio, initialStatus: "QUEUING" },
          { agentId: ids.agents.build, initialStatus: "QUEUING" },
          { agentId: ids.agents.ci, initialStatus: "QUEUING" },
        ],
      },
    },
  });

  await prisma.agentJob.createMany({
    data: AGENT_USAGE.map((usage, index) => ({
      id: `job-ccusage-collection-${index + 1}`,
      agentId: usage.agentId,
      kind: "ccusage.report",
      payloadJson: "{}",
      status: "SUCCEEDED",
      idempotencyKey: `ccusage:${ids.ccusageCollections.captured}:${usage.agentId}`,
      ccusageCollectionId: ids.ccusageCollections.captured,
      resultJson: JSON.stringify({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        report: reportFor(usage),
      }),
      timeoutSeconds: 120,
      createdAt: hoursAgo(6),
      startedAt: hoursAgo(6),
      finishedAt: hoursAgo(6),
    })),
  });
}
