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
        { modelName: "claude-sonnet-4.5", tokens: [412, 58, 96, 1_840] },
        { modelName: "gpt-5-codex", tokens: [186, 24, 0, 640] },
      ],
      [
        { modelName: "claude-sonnet-4.5", tokens: [986, 132, 214, 4_120] },
        { modelName: "claude-opus-4.1", tokens: [148, 22, 41, 610] },
        { modelName: "gpt-5-codex", tokens: [402, 51, 0, 1_380] },
      ],
      [
        { modelName: "claude-sonnet-4.5", tokens: [742, 104, 168, 3_260] },
        { modelName: "gpt-5-codex", tokens: [268, 34, 0, 910] },
      ],
      [{ modelName: "claude-sonnet-4.5", tokens: [318, 44, 71, 1_420] }],
      [
        { modelName: "claude-sonnet-4.5", tokens: [1_204, 164, 262, 5_080] },
        { modelName: "claude-opus-4.1", tokens: [206, 31, 58, 840] },
      ],
      [
        { modelName: "claude-sonnet-4.5", tokens: [864, 118, 194, 3_640] },
        { modelName: "gpt-5-codex", tokens: [312, 41, 0, 1_060] },
      ],
      null,
      [
        { modelName: "claude-sonnet-4.5", tokens: [648, 92, 148, 2_780] },
        { modelName: "gpt-5-codex", tokens: [224, 28, 0, 760] },
      ],
      [{ modelName: "claude-opus-4.1", tokens: [264, 39, 74, 1_080] }],
      [{ modelName: "claude-sonnet-4.5", tokens: [508, 71, 116, 2_180] }],
    ],
  },
  {
    agentId: ids.agents.build,
    agentName: "Build Mac",
    hostname: "build-mac.local",
    sources: ["claude"],
    days: [
      [{ modelName: "claude-sonnet-4.5", tokens: [142, 19, 34, 620] }],
      [{ modelName: "claude-sonnet-4.5", tokens: [286, 38, 62, 1_240] }],
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [198, 27, 44, 880] }],
      [{ modelName: "claude-sonnet-4.5", tokens: [364, 48, 78, 1_560] }],
      null,
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [172, 24, 38, 740] }],
      null,
      [{ modelName: "claude-sonnet-4.5", tokens: [124, 17, 29, 540] }],
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
  const total = (key: "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheReadTokens") =>
    modelBreakdowns.reduce((sum, model) => sum + model[key], 0);
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
          // Offline agents are excluded from the eligible count rather than awaited.
          { agentId: ids.agents.ci, initialStatus: "OFFLINE" },
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
