import type { PrismaClient } from "../../src/generated/prisma/client";

import { displayNumbers, ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

/**
 * Finished runs behind the five detailed ones below, so the Plans and Sessions tables show a
 * full history instead of a couple of rows. They carry one attempt, the initial input and a
 * model-usage row each — everything those tables read — but none of the events, tool calls or
 * question batches the captured detail pages need.
 *
 * Numbers count *down* from the lowest hand-written display number because these are older,
 * which keeps the ID column and the started column in the same order.
 *
 * No row is FAILED on purpose: the Action Center index treats every non-archived FAILED run as
 * a "needs attention" item, so a failed row here would add cards to the sidebar that all the
 * other screenshots show. CANCELLED gives the tables a non-green row without that.
 */
type HistoricalRun = {
  slug: string;
  status: "COMPLETED" | "CANCELLED";
  repository: "web-app" | "ios-app" | "api";
  branch: string;
  worktreeId: string;
  provider: "CLAUDE" | "CODEX";
  model: string;
  effort: "low" | "medium" | "high";
  ticket?: string;
  prompt: string;
  output: string;
  cost: number;
  /** input, output, reasoning, cache-read, cache-write — in thousands of tokens. */
  tokens: [number, number, number, number, number];
  toolCalls: number;
  hoursBack: number;
  durationMinutes: number;
};

const WEB_MAIN = ids.worktrees.webMain;
const WEB_FEATURE = ids.worktrees.webFeature;
const IOS_MAIN = ids.worktrees.iosMain;
const API_FEATURE = ids.worktrees.apiFeature;

const CLAUDE_SONNET = {
  provider: "CLAUDE",
  model: "claude-sonnet-4.5",
} as const;
const CLAUDE_OPUS = { provider: "CLAUDE", model: "claude-opus-4.1" } as const;
const CODEX = { provider: "CODEX", model: "gpt-5-codex" } as const;

const HISTORICAL_PLANS: HistoricalRun[] = [
  {
    slug: "plan-checkout-refactor",
    status: "COMPLETED",
    repository: "web-app",
    branch: "feature/checkout-refactor",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "high",
    ticket: "ACME-1231",
    prompt:
      "Plan the extraction of the checkout summary into a reusable component.",
    output:
      "Split the summary into a presentational component plus a view-model hook.",
    cost: 0.38,
    tokens: [44, 5, 2, 16, 4],
    toolCalls: 5,
    hoursBack: 6,
    durationMinutes: 4,
  },
  {
    slug: "plan-search-ranking",
    status: "COMPLETED",
    repository: "web-app",
    branch: "feature/quick-search",
    worktreeId: WEB_FEATURE,
    ...CLAUDE_OPUS,
    effort: "high",
    ticket: "ACME-1234",
    prompt: "Plan a relevance ranking pass for quick-search results.",
    output:
      "Score by recency, exact-prefix match and resource kind, then cap each group.",
    cost: 1.12,
    tokens: [38, 6, 4, 14, 3],
    toolCalls: 3,
    hoursBack: 9,
    durationMinutes: 6,
  },
  {
    slug: "plan-device-pairing",
    status: "COMPLETED",
    repository: "api",
    branch: "feature/oauth-device-flow",
    worktreeId: API_FEATURE,
    ...CODEX,
    effort: "medium",
    ticket: "ACME-1240",
    prompt:
      "Plan the device pairing screens and the polling contract behind them.",
    output:
      "Poll on a five-second floor with server-driven backoff and a 15-minute expiry.",
    cost: 0.27,
    tokens: [31, 4, 3, 9, 0],
    toolCalls: 4,
    hoursBack: 12,
    durationMinutes: 5,
  },
  {
    slug: "plan-coverage-gate",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "main",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Plan a changed-lines coverage gate for the iOS archive pipeline.",
    output:
      "Fail the build under 70% changed-line coverage, with an allowlist for generated files.",
    cost: 0.31,
    tokens: [36, 4, 2, 12, 3],
    toolCalls: 6,
    hoursBack: 18,
    durationMinutes: 4,
  },
  {
    slug: "plan-promotion-bug",
    status: "COMPLETED",
    repository: "web-app",
    branch: "fix/promotion-total",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "low",
    ticket: "ACME-1231",
    prompt: "Plan a fix for the checkout total keeping a removed promotion.",
    output:
      "Recompute the total from the server cart instead of the local discount cache.",
    cost: 0.14,
    tokens: [18, 2, 1, 6, 1],
    toolCalls: 2,
    hoursBack: 22,
    durationMinutes: 2,
  },
  {
    slug: "plan-design-tokens",
    status: "CANCELLED",
    repository: "web-app",
    branch: "chore/design-system-v4",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Plan the migration off the deprecated design-system token names.",
    output: "",
    cost: 0.06,
    tokens: [9, 1, 0, 3, 1],
    toolCalls: 1,
    hoursBack: 27,
    durationMinutes: 1,
  },
  {
    slug: "plan-push-preferences",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "feature/push-preferences",
    worktreeId: IOS_MAIN,
    ...CODEX,
    effort: "medium",
    prompt: "Plan per-category push notification preferences for the iOS app.",
    output:
      "Store preferences server-side and mirror them into the APNs registration payload.",
    cost: 0.22,
    tokens: [27, 3, 2, 8, 0],
    toolCalls: 3,
    hoursBack: 31,
    durationMinutes: 4,
  },
  {
    slug: "plan-cache-eviction",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "main",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "high",
    prompt: "Plan a size-aware eviction policy for the on-device cache store.",
    output:
      "Evict by cost-weighted LRU with a soft ceiling and a hard ceiling.",
    cost: 0.44,
    tokens: [51, 7, 4, 19, 5],
    toolCalls: 7,
    hoursBack: 36,
    durationMinutes: 7,
  },
  {
    slug: "plan-rate-limiter",
    status: "COMPLETED",
    repository: "api",
    branch: "feature/oauth-device-flow",
    worktreeId: API_FEATURE,
    ...CLAUDE_OPUS,
    effort: "high",
    ticket: "ACME-1240",
    prompt:
      "Plan the polling rate limiter for the device authorization endpoint.",
    output:
      "Token bucket per device code, with slow-down responses instead of hard failures.",
    cost: 1.36,
    tokens: [42, 8, 6, 15, 4],
    toolCalls: 4,
    hoursBack: 44,
    durationMinutes: 8,
  },
  {
    slug: "plan-graphql-pagination",
    status: "COMPLETED",
    repository: "api",
    branch: "chore/graphql-pagination",
    worktreeId: API_FEATURE,
    ...CODEX,
    effort: "medium",
    prompt:
      "Plan cursor pagination for the remaining offset-based list queries.",
    output:
      "Move to opaque cursors keyed on (createdAt, id) and keep offset for one release.",
    cost: 0.29,
    tokens: [34, 4, 3, 11, 0],
    toolCalls: 5,
    hoursBack: 52,
    durationMinutes: 5,
  },
  {
    slug: "plan-webhook-replay",
    status: "COMPLETED",
    repository: "api",
    branch: "feature/webhook-replay",
    worktreeId: API_FEATURE,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Plan a replay path for GitHub webhook deliveries that errored.",
    output:
      "Persist the raw payload, then replay through the same handler behind an idempotency key.",
    cost: 0.33,
    tokens: [39, 5, 2, 14, 3],
    toolCalls: 4,
    hoursBack: 60,
    durationMinutes: 6,
  },
  {
    slug: "plan-onboarding-flow",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "feature/onboarding-v2",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "low",
    prompt: "Plan a shorter onboarding flow with a skippable permissions step.",
    output:
      "Three screens, with push and location permissions deferred to first use.",
    cost: 0.17,
    tokens: [21, 3, 1, 7, 2],
    toolCalls: 2,
    hoursBack: 74,
    durationMinutes: 3,
  },
  {
    slug: "plan-telemetry-schema",
    status: "COMPLETED",
    repository: "web-app",
    branch: "chore/telemetry-schema",
    worktreeId: WEB_MAIN,
    ...CODEX,
    effort: "medium",
    prompt: "Plan a versioned schema for the analytics event payloads.",
    output:
      "Version each event name and validate payloads at the ingestion boundary.",
    cost: 0.24,
    tokens: [29, 4, 2, 10, 0],
    toolCalls: 3,
    hoursBack: 84,
    durationMinutes: 4,
  },
  {
    slug: "plan-accessibility-audit",
    status: "COMPLETED",
    repository: "web-app",
    branch: "chore/accessibility-audit",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Plan an accessibility pass over the checkout and catalog screens.",
    output:
      "Fix focus order first, then contrast, then the missing form labels.",
    cost: 0.36,
    tokens: [42, 5, 3, 15, 4],
    toolCalls: 6,
    hoursBack: 96,
    durationMinutes: 5,
  },
  {
    slug: "plan-build-caching",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "chore/build-caching",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "high",
    ticket: "ACME-1228",
    prompt: "Plan provisioning-profile caching between archive builds.",
    output:
      "Key the cache on the signing-asset digest and invalidate on profile expiry.",
    cost: 0.41,
    tokens: [48, 6, 4, 17, 4],
    toolCalls: 5,
    hoursBack: 108,
    durationMinutes: 6,
  },
  {
    slug: "plan-error-taxonomy",
    status: "CANCELLED",
    repository: "api",
    branch: "chore/error-taxonomy",
    worktreeId: API_FEATURE,
    ...CODEX,
    effort: "low",
    prompt:
      "Plan a shared error taxonomy across the API and the control agent.",
    output: "",
    cost: 0.05,
    tokens: [7, 1, 0, 2, 0],
    toolCalls: 1,
    hoursBack: 120,
    durationMinutes: 1,
  },
  {
    slug: "plan-session-tracking",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "main",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt:
      "Plan session tracking that survives a cold launch from a push notification.",
    output:
      "Persist the session id in the keychain and stitch on the first foreground event.",
    cost: 0.28,
    tokens: [33, 4, 2, 12, 3],
    toolCalls: 4,
    hoursBack: 132,
    durationMinutes: 4,
  },
];

const HISTORICAL_SESSIONS: HistoricalRun[] = [
  {
    slug: "session-checkout-refactor",
    status: "COMPLETED",
    repository: "web-app",
    branch: "feature/checkout-refactor",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "high",
    ticket: "ACME-1231",
    prompt: "Extract the checkout summary into its own component.",
    output:
      "Extracted `CheckoutSummary`, wired it into the order confirmation screen and added tests.",
    cost: 1.64,
    tokens: [148, 24, 11, 72, 14],
    toolCalls: 16,
    hoursBack: 5,
    durationMinutes: 22,
  },
  {
    slug: "session-search-ranking",
    status: "COMPLETED",
    repository: "web-app",
    branch: "feature/quick-search",
    worktreeId: WEB_FEATURE,
    ...CLAUDE_SONNET,
    effort: "high",
    ticket: "ACME-1234",
    prompt: "Implement the relevance ranking pass for quick-search results.",
    output:
      "Ranked results by recency and prefix match, and capped each group at five items.",
    cost: 1.18,
    tokens: [112, 19, 8, 58, 11],
    toolCalls: 13,
    hoursBack: 8,
    durationMinutes: 18,
  },
  {
    slug: "session-promotion-bug",
    status: "COMPLETED",
    repository: "web-app",
    branch: "fix/promotion-total",
    worktreeId: WEB_MAIN,
    ...CODEX,
    effort: "medium",
    ticket: "ACME-1231",
    prompt: "Fix the checkout total keeping a removed promotion until reload.",
    output:
      "Recomputed the total from the server cart and added a regression test.",
    cost: 0.42,
    tokens: [61, 9, 5, 22, 0],
    toolCalls: 8,
    hoursBack: 11,
    durationMinutes: 12,
  },
  {
    slug: "session-device-pairing",
    status: "COMPLETED",
    repository: "api",
    branch: "feature/oauth-device-flow",
    worktreeId: API_FEATURE,
    ...CODEX,
    effort: "high",
    ticket: "ACME-1240",
    prompt: "Implement the device pairing endpoints and the polling contract.",
    output:
      "Added the pairing endpoints with slow-down responses and a 15-minute expiry.",
    cost: 0.86,
    tokens: [96, 14, 9, 34, 0],
    toolCalls: 19,
    hoursBack: 14,
    durationMinutes: 26,
  },
  {
    slug: "session-coverage-gate",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "main",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Add the changed-lines coverage gate to the archive pipeline.",
    output:
      "Gate fails under 70% changed-line coverage and skips generated sources.",
    cost: 0.74,
    tokens: [82, 12, 6, 38, 8],
    toolCalls: 11,
    hoursBack: 19,
    durationMinutes: 15,
  },
  {
    slug: "session-design-tokens",
    status: "CANCELLED",
    repository: "web-app",
    branch: "chore/design-system-v4",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Migrate the deprecated design-system token names.",
    output: "",
    cost: 0.19,
    tokens: [24, 3, 1, 9, 2],
    toolCalls: 3,
    hoursBack: 24,
    durationMinutes: 4,
  },
  {
    slug: "session-push-preferences",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "feature/push-preferences",
    worktreeId: IOS_MAIN,
    ...CODEX,
    effort: "medium",
    prompt: "Add per-category push notification preferences.",
    output:
      "Preferences persist server-side and ship in the APNs registration payload.",
    cost: 0.58,
    tokens: [74, 11, 7, 27, 0],
    toolCalls: 12,
    hoursBack: 29,
    durationMinutes: 17,
  },
  {
    slug: "session-cache-eviction",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "main",
    worktreeId: IOS_MAIN,
    ...CLAUDE_OPUS,
    effort: "high",
    prompt:
      "Implement the cost-weighted LRU eviction policy for the cache store.",
    output:
      "Added soft and hard ceilings with eviction metrics behind a debug flag.",
    cost: 3.42,
    tokens: [128, 21, 14, 61, 12],
    toolCalls: 21,
    hoursBack: 34,
    durationMinutes: 31,
  },
  {
    slug: "session-rate-limiter",
    status: "COMPLETED",
    repository: "api",
    branch: "feature/oauth-device-flow",
    worktreeId: API_FEATURE,
    ...CODEX,
    effort: "high",
    ticket: "ACME-1240",
    prompt: "Implement the token-bucket rate limiter for device polling.",
    output:
      "Limiter is per device code and returns slow-down instead of failing the poll.",
    cost: 0.79,
    tokens: [88, 13, 8, 31, 0],
    toolCalls: 14,
    hoursBack: 41,
    durationMinutes: 19,
  },
  {
    slug: "session-graphql-pagination",
    status: "COMPLETED",
    repository: "api",
    branch: "chore/graphql-pagination",
    worktreeId: API_FEATURE,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Move the remaining offset list queries onto cursor pagination.",
    output:
      "Cursors are opaque and keyed on (createdAt, id); offset stays for one release.",
    cost: 1.02,
    tokens: [104, 16, 7, 49, 10],
    toolCalls: 15,
    hoursBack: 50,
    durationMinutes: 23,
  },
  {
    slug: "session-webhook-replay",
    status: "COMPLETED",
    repository: "api",
    branch: "feature/webhook-replay",
    worktreeId: API_FEATURE,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Add the replay path for errored GitHub webhook deliveries.",
    output:
      "Raw payloads are persisted and replayed behind the delivery idempotency key.",
    cost: 0.91,
    tokens: [94, 14, 6, 44, 9],
    toolCalls: 12,
    hoursBack: 58,
    durationMinutes: 20,
  },
  {
    slug: "session-onboarding-flow",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "feature/onboarding-v2",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "low",
    prompt: "Rebuild onboarding as three screens with deferred permissions.",
    output:
      "Onboarding is three screens; push and location prompts moved to first use.",
    cost: 0.48,
    tokens: [56, 8, 3, 26, 6],
    toolCalls: 9,
    hoursBack: 71,
    durationMinutes: 14,
  },
  {
    slug: "session-telemetry-schema",
    status: "COMPLETED",
    repository: "web-app",
    branch: "chore/telemetry-schema",
    worktreeId: WEB_MAIN,
    ...CODEX,
    effort: "medium",
    prompt: "Version the analytics event payloads and validate them on ingest.",
    output:
      "Every event name carries a version and is validated at the ingestion boundary.",
    cost: 0.53,
    tokens: [68, 10, 6, 24, 0],
    toolCalls: 10,
    hoursBack: 82,
    durationMinutes: 16,
  },
  {
    slug: "session-accessibility-audit",
    status: "COMPLETED",
    repository: "web-app",
    branch: "chore/accessibility-audit",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt:
      "Fix the focus order and contrast findings on checkout and catalog.",
    output:
      "Focus order, contrast and missing labels are fixed on both screens.",
    cost: 0.87,
    tokens: [92, 13, 6, 42, 9],
    toolCalls: 17,
    hoursBack: 94,
    durationMinutes: 21,
  },
  {
    slug: "session-build-caching",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "chore/build-caching",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "high",
    ticket: "ACME-1228",
    prompt: "Cache provisioning profiles between archive builds.",
    output:
      "Profiles are cached on the signing-asset digest; archive builds skip the scan.",
    cost: 1.31,
    tokens: [124, 18, 9, 59, 12],
    toolCalls: 18,
    hoursBack: 106,
    durationMinutes: 27,
  },
  {
    slug: "session-error-taxonomy",
    status: "COMPLETED",
    repository: "api",
    branch: "chore/error-taxonomy",
    worktreeId: API_FEATURE,
    ...CODEX,
    effort: "low",
    prompt: "Introduce the shared error taxonomy across the API and the agent.",
    output:
      "Both sides now emit the same error codes and map them at the boundary.",
    cost: 0.36,
    tokens: [48, 7, 4, 17, 0],
    toolCalls: 7,
    hoursBack: 118,
    durationMinutes: 11,
  },
  {
    slug: "session-session-tracking",
    status: "COMPLETED",
    repository: "ios-app",
    branch: "main",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt:
      "Keep analytics sessions stitched across a cold launch from a push.",
    output:
      "Session ids persist in the keychain and stitch on the first foreground event.",
    cost: 0.69,
    tokens: [78, 11, 5, 35, 7],
    toolCalls: 11,
    hoursBack: 130,
    durationMinutes: 18,
  },
  {
    slug: "session-flaky-payments",
    status: "COMPLETED",
    repository: "api",
    branch: "fix/flaky-payment-webhooks",
    worktreeId: API_FEATURE,
    ...CLAUDE_OPUS,
    effort: "high",
    prompt: "Fix the race condition in the payment webhook handler.",
    output:
      "Handler takes a per-order advisory lock; the flaky integration tests now pass.",
    cost: 2.87,
    tokens: [116, 18, 12, 54, 11],
    toolCalls: 16,
    hoursBack: 144,
    durationMinutes: 29,
  },
];

/**
 * Saved prompts behind the one detailed draft. Drafts render the mode, worktree, ticket,
 * prompt, tool and attachment count, so nothing else is needed.
 */
const HISTORICAL_DRAFTS: Array<{
  slug: string;
  kind: "PLAN" | "SESSION";
  worktreeId: string;
  provider: "CLAUDE" | "CODEX";
  model: string;
  effort: "low" | "medium" | "high";
  prompt: string;
  hoursBack: number;
}> = [
  {
    slug: "search-empty-state",
    kind: "SESSION",
    worktreeId: WEB_FEATURE,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt:
      "Add an empty state to quick search that suggests recent worktrees.",
    hoursBack: 5,
  },
  {
    slug: "device-flow-docs",
    kind: "PLAN",
    worktreeId: API_FEATURE,
    ...CODEX,
    effort: "low",
    prompt:
      "Draft the developer documentation for the OAuth device authorization flow.",
    hoursBack: 9,
  },
  {
    slug: "catalog-prefetch",
    kind: "SESSION",
    worktreeId: IOS_MAIN,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt:
      "Prefetch the next catalog page once the user scrolls past the halfway mark.",
    hoursBack: 14,
  },
  {
    slug: "flaky-test-sweep",
    kind: "PLAN",
    worktreeId: WEB_MAIN,
    ...CLAUDE_OPUS,
    effort: "high",
    prompt:
      "Find every test that has failed intermittently this month and group them by cause.",
    hoursBack: 21,
  },
  {
    slug: "keychain-migration",
    kind: "SESSION",
    worktreeId: IOS_MAIN,
    ...CODEX,
    effort: "high",
    prompt:
      "Migrate the token store off the legacy keychain accessibility class.",
    hoursBack: 30,
  },
  {
    slug: "graphql-error-codes",
    kind: "SESSION",
    worktreeId: API_FEATURE,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt:
      "Return typed error codes from every mutation instead of bare messages.",
    hoursBack: 46,
  },
  {
    slug: "worktree-cleanup",
    kind: "PLAN",
    worktreeId: WEB_MAIN,
    ...CLAUDE_SONNET,
    effort: "low",
    prompt:
      "Plan an automatic cleanup for worktrees whose branch has been merged.",
    hoursBack: 58,
  },
  {
    slug: "snapshot-tests",
    kind: "SESSION",
    worktreeId: WEB_FEATURE,
    ...CLAUDE_SONNET,
    effort: "medium",
    prompt: "Add snapshot tests for the quick-search result groups.",
    hoursBack: 79,
  },
  {
    slug: "build-script-timeouts",
    kind: "PLAN",
    worktreeId: IOS_MAIN,
    ...CODEX,
    effort: "low",
    prompt:
      "Plan per-script timeouts and a shared default for the build script runner.",
    hoursBack: 102,
  },
];

const K = 1_000;

/**
 * Creates one finished run with the minimum the Plans and Sessions tables read. `displayNumber`
 * is passed in rather than derived so both callers keep their own descending block of numbers.
 */
async function createHistoricalRun(
  prisma: PrismaClient,
  kind: "PLAN" | "SESSION",
  run: HistoricalRun,
  displayNumber: number,
): Promise<void> {
  const startedAt = hoursAgo(run.hoursBack);
  const finishedAt = minutesAgo(run.hoursBack * 60 - run.durationMinutes);
  const [input, output, reasoning, cacheRead, cacheWrite] = run.tokens;
  const usage = {
    inputTokens: input * K,
    outputTokens: output * K,
    reasoningTokens: reasoning * K,
    cacheReadTokens: cacheRead * K,
    cacheWriteTokens: cacheWrite * K,
  };
  await prisma.agentRun.create({
    data: {
      id: `run-${run.slug}`,
      kind,
      displayNumber,
      status: run.status,
      phase: run.status,
      origin: "MANAGED",
      provider: run.provider,
      worktreeId: run.worktreeId,
      agentId: ids.agents.studio,
      jiraIssueKey: run.ticket ?? null,
      repositoryName: `acme/${run.repository}`,
      branch: run.branch,
      model: run.model,
      effort: run.effort,
      webSearchEnabled: false,
      initialPrompt: run.prompt,
      finalOutput: run.output || null,
      estimatedCost: run.cost,
      pricingSource: "catalog",
      pricingUpdatedAt: startedAt,
      ...usage,
      toolCallCount: run.toolCalls,
      startedAt,
      finishedAt,
      createdAt: startedAt,
      attempts: {
        create: [
          {
            id: `attempt-${run.slug}-1`,
            generation: 1,
            nativeId: `${run.provider.toLowerCase()}-${run.slug}`,
            status: run.status,
            startedAt,
            finishedAt,
          },
        ],
      },
      inputs: {
        create: [
          {
            id: `input-${run.slug}-1`,
            sequence: 1,
            kind: "INITIAL",
            prompt: run.prompt,
            createdAt: startedAt,
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: `usage-${run.slug}-1`,
            model: run.model,
            ...usage,
            estimatedCost: run.cost,
          },
        ],
      },
    },
  });
}

export async function seedRuns(prisma: PrismaClient): Promise<void> {
  // Plan that was played into a session.
  await prisma.agentRun.create({
    data: {
      id: ids.runs.planSearch,
      kind: "PLAN",
      displayNumber: displayNumbers.runs.planSearch,
      status: "COMPLETED",
      phase: "COMPLETED",
      origin: "MANAGED",
      provider: "CLAUDE",
      providerVersion: "claude-agent-sdk 0.3.2",
      worktreeId: ids.worktrees.webFeature,
      agentId: ids.agents.studio,
      jiraIssueKey: ids.jira.issueKey,
      repositoryName: "acme/web-app",
      branch: "feature/quick-search",
      model: "claude-sonnet-4.5",
      effort: "high",
      webSearchEnabled: true,
      initialPrompt:
        "Design a quick-search feature for the global navigation bar. Outline the component structure, data fetching, and keyboard shortcuts.",
      finalOutput:
        "## Quick Search Plan\n\n1. Add a `QuickSearch` command palette triggered by ⌘K.\n2. Debounce queries and call the `/api/search` endpoint.\n3. Surface recent items and keyboard navigation.\n\nReady to implement.",
      estimatedCost: 0.42,
      pricingSource: "catalog",
      pricingUpdatedAt: hoursAgo(6),
      inputTokens: 48210,
      outputTokens: 6120,
      reasoningTokens: 3040,
      cacheReadTokens: 18400,
      cacheWriteTokens: 5200,
      toolCallCount: 4,
      playedAt: daysAgo(4),
      playedSessionNumber: displayNumbers.runs.sessionSearch,
      startedAt: daysAgo(5),
      finishedAt: daysAgo(5),
      createdAt: daysAgo(5),
      attempts: {
        create: [
          {
            id: "attempt-plan-search-1",
            generation: 1,
            nativeId: "claude-plan-abc123",
            status: "COMPLETED",
            startedAt: daysAgo(5),
            finishedAt: daysAgo(5),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-plan-search-1",
            sequence: 1,
            kind: "INITIAL",
            prompt:
              "Design a quick-search feature for the global navigation bar.",
            createdAt: daysAgo(5),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-plan-search-1",
            sequence: 1,
            type: "REASONING",
            summary: "Analyzing existing navigation components",
            searchText: "analyzing existing navigation components",
            detailMarkdown:
              "Reviewed `NavigationBar` and existing search endpoints to plan the palette.",
            createdAt: daysAgo(5),
          },
          {
            id: "event-plan-search-2",
            sequence: 2,
            type: "MESSAGE",
            summary: "Proposed the quick-search plan",
            searchText: "proposed the quick-search plan",
            detailMarkdown:
              "Outlined a ⌘K command palette with debounced search.",
            createdAt: daysAgo(5),
          },
        ],
      },
      toolCalls: {
        create: [
          {
            id: "tool-plan-search-1",
            sequence: 1,
            name: "read_file",
            status: "SUCCEEDED",
            inputJson: JSON.stringify({
              path: "src/components/navigation-bar.tsx",
            }),
            outputJson: JSON.stringify({ lines: 180 }),
            startedAt: daysAgo(5),
            finishedAt: daysAgo(5),
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-plan-search-1",
            model: "claude-sonnet-4.5",
            inputTokens: 48210,
            outputTokens: 6120,
            reasoningTokens: 3040,
            cacheReadTokens: 18400,
            cacheWriteTokens: 5200,
            estimatedCost: 0.42,
          },
        ],
      },
    },
  });

  // Session played from the plan above.
  await prisma.agentRun.create({
    data: {
      id: ids.runs.sessionSearch,
      kind: "SESSION",
      displayNumber: displayNumbers.runs.sessionSearch,
      status: "COMPLETED",
      phase: "COMPLETED",
      origin: "MANAGED",
      provider: "CLAUDE",
      providerVersion: "claude-agent-sdk 0.3.2",
      worktreeId: ids.worktrees.webFeature,
      agentId: ids.agents.studio,
      jiraIssueKey: ids.jira.issueKey,
      repositoryName: "acme/web-app",
      branch: "feature/quick-search",
      model: "claude-sonnet-4.5",
      effort: "high",
      webSearchEnabled: false,
      initialPrompt:
        "Implement the quick-search command palette from the plan.",
      finalOutput:
        "Implemented the ⌘K command palette, wired it to `/api/search`, and added keyboard navigation with tests.",
      error: null,
      estimatedCost: 1.28,
      pricingSource: "catalog",
      pricingUpdatedAt: hoursAgo(6),
      inputTokens: 132400,
      outputTokens: 21850,
      reasoningTokens: 9800,
      cacheReadTokens: 64200,
      cacheWriteTokens: 12100,
      toolCallCount: 12,
      sourcePlanId: ids.runs.planSearch,
      sourcePlanNumber: displayNumbers.runs.planSearch,
      startedAt: daysAgo(4),
      finishedAt: daysAgo(4),
      createdAt: daysAgo(4),
      attempts: {
        create: [
          {
            id: "attempt-session-search-1",
            generation: 1,
            nativeId: "claude-session-def456",
            status: "COMPLETED",
            startedAt: daysAgo(4),
            finishedAt: daysAgo(4),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-session-search-1",
            sequence: 1,
            kind: "INITIAL",
            prompt: "Implement the quick-search command palette from the plan.",
            createdAt: daysAgo(4),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-session-search-1",
            sequence: 1,
            type: "TOOL_CALL",
            summary: "Created quick-search component",
            searchText: "created quick-search component",
            detailMarkdown: "Added `src/components/quick-search.tsx`.",
            createdAt: daysAgo(4),
          },
          {
            id: "event-session-search-2",
            sequence: 2,
            type: "MESSAGE",
            summary: "Summarized the implementation",
            searchText: "summarized the implementation",
            createdAt: daysAgo(4),
          },
        ],
      },
      toolCalls: {
        create: [
          {
            id: "tool-session-search-1",
            sequence: 1,
            name: "apply_patch",
            status: "SUCCEEDED",
            inputJson: JSON.stringify({
              file: "src/components/quick-search.tsx",
            }),
            startedAt: daysAgo(4),
            finishedAt: daysAgo(4),
          },
          {
            id: "tool-session-search-2",
            sequence: 2,
            name: "run_terminal",
            status: "SUCCEEDED",
            inputJson: JSON.stringify({ command: "npm test" }),
            outputJson: JSON.stringify({ exitCode: 0 }),
            startedAt: daysAgo(4),
            finishedAt: daysAgo(4),
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-session-search-1",
            model: "claude-sonnet-4.5",
            inputTokens: 132400,
            outputTokens: 21850,
            reasoningTokens: 9800,
            cacheReadTokens: 64200,
            cacheWriteTokens: 12100,
            estimatedCost: 1.28,
          },
        ],
      },
    },
  });

  // In-progress session on another worktree.
  await prisma.agentRun.create({
    data: {
      id: ids.runs.sessionAuth,
      kind: "SESSION",
      displayNumber: displayNumbers.runs.sessionAuth,
      status: "IN_PROGRESS",
      phase: "EXECUTING",
      origin: "MANAGED",
      provider: "CODEX",
      providerVersion: "codex-sdk 0.14",
      worktreeId: ids.worktrees.apiFeature,
      agentId: ids.agents.studio,
      repositoryName: "acme/api",
      branch: "feature/oauth-device-flow",
      model: "gpt-5-codex",
      effort: "medium",
      webSearchEnabled: false,
      initialPrompt: "Add the OAuth 2.0 device authorization flow to the API.",
      estimatedCost: 0.64,
      inputTokens: 74100,
      outputTokens: 8300,
      reasoningTokens: 5200,
      cacheReadTokens: 21000,
      toolCallCount: 6,
      startedAt: minutesAgo(18),
      createdAt: minutesAgo(20),
      attempts: {
        create: [
          {
            id: "attempt-session-auth-1",
            generation: 1,
            nativeId: "codex-session-ghi789",
            status: "RUNNING",
            startedAt: minutesAgo(18),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-session-auth-1",
            sequence: 1,
            kind: "INITIAL",
            prompt: "Add the OAuth 2.0 device authorization flow to the API.",
            createdAt: minutesAgo(20),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-session-auth-1",
            sequence: 1,
            type: "TOOL_CALL",
            summary: "Reading existing auth middleware",
            searchText: "reading existing auth middleware",
            createdAt: minutesAgo(17),
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-session-auth-1",
            model: "gpt-5-codex",
            inputTokens: 74100,
            outputTokens: 8300,
            reasoningTokens: 5200,
            cacheReadTokens: 21000,
            estimatedCost: 0.64,
          },
        ],
      },
    },
  });

  /**
   * Paused waiting on an answer. A PENDING RunQuestionBatch on a non-FAILED run is what the
   * Action Center index classifies as reason QUESTION — its highest priority — so this is the
   * item that renders the answer form at the top of the Action Center and the sidebar.
   */
  await prisma.agentRun.create({
    data: {
      id: ids.runs.planCheckoutQuestion,
      kind: "PLAN",
      displayNumber: displayNumbers.runs.planCheckoutQuestion,
      status: "PAUSED",
      phase: "WAITING_FOR_ANSWER",
      origin: "MANAGED",
      provider: "CLAUDE",
      providerVersion: "claude-agent-sdk 0.3.2",
      worktreeId: ids.worktrees.webFeature,
      agentId: ids.agents.studio,
      repositoryName: "acme/web-app",
      branch: "feature/quick-search",
      model: "claude-sonnet-4.5",
      effort: "high",
      webSearchEnabled: false,
      initialPrompt:
        "Plan a migration of the checkout flow onto the new payments SDK, keeping the existing gift-card path working.",
      estimatedCost: 0.18,
      inputTokens: 22600,
      outputTokens: 2840,
      reasoningTokens: 1420,
      cacheReadTokens: 8100,
      toolCallCount: 3,
      startedAt: minutesAgo(26),
      createdAt: minutesAgo(28),
      updatedAt: minutesAgo(21),
      attempts: {
        create: [
          {
            id: "attempt-plan-checkout-1",
            generation: 1,
            nativeId: "claude-plan-jkl012",
            status: "RUNNING",
            startedAt: minutesAgo(26),
          },
        ],
      },
      inputs: {
        create: [
          {
            id: "input-plan-checkout-1",
            sequence: 1,
            kind: "INITIAL",
            prompt:
              "Plan a migration of the checkout flow onto the new payments SDK.",
            createdAt: minutesAgo(28),
          },
        ],
      },
      events: {
        create: [
          {
            id: "event-plan-checkout-1",
            sequence: 1,
            type: "TOOL_CALL",
            summary: "Reviewed the current payments integration",
            searchText: "reviewed the current payments integration",
            createdAt: minutesAgo(25),
          },
          {
            id: "event-plan-checkout-2",
            sequence: 2,
            type: "QUESTION",
            summary: "Asked how to handle gift cards during the migration",
            searchText: "asked how to handle gift cards during the migration",
            createdAt: minutesAgo(21),
          },
        ],
      },
      questionBatches: {
        create: [
          {
            id: ids.runQuestionBatches.planCheckout,
            nativeRequestId: "claude-question-checkout-1",
            eventSequence: 2,
            status: "PENDING",
            createdAt: minutesAgo(21),
            questions: {
              create: [
                {
                  id: "question-plan-checkout-1",
                  position: 0,
                  header: "Gift cards",
                  prompt:
                    "The new payments SDK has no gift-card primitive. How should the migration handle existing gift-card balances?",
                  multiSelect: false,
                  allowCustom: true,
                  options: {
                    create: [
                      {
                        id: "question-option-checkout-1",
                        position: 0,
                        label: "Keep the legacy path",
                        description:
                          "Route gift-card orders through the current integration until the SDK ships support.",
                      },
                      {
                        id: "question-option-checkout-2",
                        position: 1,
                        label: "Model them as store credit",
                        description:
                          "Convert balances to store credit and apply them as a discount line.",
                      },
                      {
                        id: "question-option-checkout-3",
                        position: 2,
                        label: "Block the migration",
                        description:
                          "Wait for first-class gift-card support before migrating checkout.",
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
      modelUsage: {
        create: [
          {
            id: "usage-plan-checkout-1",
            model: "claude-sonnet-4.5",
            inputTokens: 22600,
            outputTokens: 2840,
            reasoningTokens: 1420,
            cacheReadTokens: 8100,
            estimatedCost: 0.18,
          },
        ],
      },
    },
  });

  // Imported plan (no managed worktree relationship).
  await prisma.agentRun.create({
    data: {
      id: ids.runs.planImported,
      kind: "PLAN",
      displayNumber: displayNumbers.runs.planImported,
      status: "COMPLETED",
      phase: "COMPLETED",
      origin: "IMPORTED",
      provider: "CODEX",
      agentId: ids.agents.studio,
      repositoryName: "acme/api",
      model: "gpt-5-codex",
      webSearchEnabled: false,
      initialPrompt:
        "Investigate flaky integration tests in the payments module.",
      finalOutput:
        "Identified a race condition in the payment webhook handler and proposed a locking strategy.",
      estimatedCost: 0.21,
      inputTokens: 28400,
      outputTokens: 3900,
      toolCallCount: 2,
      startedAt: daysAgo(8),
      finishedAt: daysAgo(8),
      createdAt: daysAgo(8),
    },
  });

  // Newest history run first, counting down from just below the lowest hand-written number.
  for (const [index, run] of HISTORICAL_PLANS.entries()) {
    await createHistoricalRun(
      prisma,
      "PLAN",
      run,
      displayNumbers.runs.planSearch - 1 - index,
    );
  }
  for (const [index, run] of HISTORICAL_SESSIONS.entries()) {
    await createHistoricalRun(
      prisma,
      "SESSION",
      run,
      displayNumbers.runs.sessionSearch - 1 - index,
    );
  }

  await prisma.runNumberSequence.createMany({
    data: [
      { kind: "PLAN", nextValue: 1004 },
      { kind: "SESSION", nextValue: 2003 },
    ],
  });

  await prisma.runDraft.create({
    data: {
      id: ids.runDrafts.refactor,
      kind: "SESSION",
      worktreeId: ids.worktrees.webMain,
      agentId: ids.agents.studio,
      provider: "CLAUDE",
      model: "claude-sonnet-4.5",
      effort: "medium",
      webSearchEnabled: false,
      prompt:
        "Refactor the checkout flow to extract a reusable payment form component.",
      createdAt: hoursAgo(3),
    },
  });

  await prisma.runDraft.createMany({
    data: HISTORICAL_DRAFTS.map((draft) => ({
      id: `draft-${draft.slug}`,
      kind: draft.kind,
      worktreeId: draft.worktreeId,
      agentId: ids.agents.studio,
      provider: draft.provider,
      model: draft.model,
      effort: draft.effort,
      webSearchEnabled: false,
      prompt: draft.prompt,
      createdAt: hoursAgo(draft.hoursBack),
      // The Drafts table sorts and labels by updatedAt, so it has to be set explicitly —
      // left to Prisma's @updatedAt default every row would read as seeded seconds ago.
      updatedAt: hoursAgo(draft.hoursBack),
    })),
  });
}
