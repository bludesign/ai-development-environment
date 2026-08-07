/**
 * Stub GitHub and Jira API server for the screenshot capture run.
 *
 * The Pull Requests, Actions, Comments and Jira pages have no local tables — they always read
 * through the live API (with a response cache in front), so seeding the database alone leaves
 * them on their "connect your account" empty state. This server answers those calls with the
 * same generic "Acme" data the rest of the mock seed uses, so the pages render fully without
 * any network access.
 *
 * The capture run points the app here with GITHUB_API_BASE_URL / GITHUB_GRAPHQL_URL and the
 * seeded Jira `siteUrl`. It is never used outside the screenshot run.
 *
 *   npx tsx scripts/mock-api-server.ts [--port 4322]
 *
 * Unmatched requests are logged with their operation/path and answered with an empty-but-valid
 * payload, so a new page can be added by running it and reading the log.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { NOW } from "./mock-data/time";

const PORT = Number(
  process.argv[process.argv.indexOf("--port") + 1] ||
    process.env.MOCK_API_PORT ||
    4322,
);

const OWNER = "acme";
const REPOS = ["web-app", "ios-app", "api"] as const;
const VIEWER_LOGIN = "jane-doe";

const now = NOW.getTime();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

/**
 * Avatars are inline SVG data URIs rather than remote URLs: the capture run has no network, so
 * a real avatar host would leave broken images in every screenshot.
 */
const AVATAR_COLORS = ["#3b7dd8", "#c2410c", "#0f766e", "#7c3aed", "#b91c1c"];

function avatarFor(name: string): string {
  const initials = name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  let hash = 0;
  for (const character of name)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const background = AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" rx="48" fill="${background}"/>` +
    `<text x="48" y="49" fill="#ffffff" font-family="Helvetica,Arial,sans-serif" ` +
    `font-size="38" font-weight="600" text-anchor="middle" dominant-baseline="central">` +
    `${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

const AVATAR = avatarFor("Acme");

const actor = (login: string) => ({
  login,
  avatarUrl: avatarFor(login),
  url: `https://github.com/${login}`,
});

const repositoryNode = (name: string) => ({
  id: `R_kgACME${name.replace(/[^a-z]/gi, "")}`,
  nameWithOwner: `${OWNER}/${name}`,
  url: `https://github.com/${OWNER}/${name}`,
});

const connection = <T>(nodes: T[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});

type PullRequestSeed = {
  number: number;
  repository: (typeof REPOS)[number];
  title: string;
  author: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  rollup: "SUCCESS" | "FAILURE" | "PENDING";
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  updatedMinutesAgo: number;
  createdMinutesAgo: number;
  body: string;
};

const PULL_REQUESTS: PullRequestSeed[] = [
  {
    number: 42,
    repository: "web-app",
    title: "Add quick search to the global navigation bar",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "CHANGES_REQUESTED",
    rollup: "FAILURE",
    labels: ["frontend", "search", "ACME-1234"],
    additions: 486,
    deletions: 92,
    changedFiles: 14,
    commits: 7,
    updatedMinutesAgo: 24,
    createdMinutesAgo: 60 * 30,
    body: "Adds a command-palette style quick search to the global navigation bar.\n\n- Debounced query input\n- Keyboard navigation between result groups\n- Telemetry for opened results\n\nCloses ACME-1234.",
  },
  {
    number: 41,
    repository: "web-app",
    title: "Extract checkout summary into its own component",
    author: "john-smith",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    rollup: "SUCCESS",
    labels: ["frontend", "refactor"],
    additions: 214,
    deletions: 268,
    changedFiles: 9,
    commits: 4,
    updatedMinutesAgo: 95,
    createdMinutesAgo: 60 * 52,
    body: "Pure refactor — no behaviour change. Splits the checkout summary out of the page component so it can be reused by the order confirmation screen.",
  },
  {
    number: 40,
    repository: "api",
    title: "Add the OAuth 2.0 device authorization flow",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
    rollup: "PENDING",
    labels: ["backend", "auth", "ACME-1240"],
    additions: 712,
    deletions: 38,
    changedFiles: 21,
    commits: 11,
    updatedMinutesAgo: 12,
    createdMinutesAgo: 60 * 35,
    body: "Implements RFC 8628 device authorization. Still a draft: the polling rate limiter needs load testing before review.",
  },
  {
    number: 118,
    repository: "ios-app",
    title: "Cache provisioning profiles between archive builds",
    author: "sam-rivera",
    state: "OPEN",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    rollup: "SUCCESS",
    labels: ["ios", "build"],
    additions: 132,
    deletions: 46,
    changedFiles: 6,
    commits: 3,
    updatedMinutesAgo: 240,
    createdMinutesAgo: 60 * 74,
    body: "Keeps resolved provisioning profiles in the build cache so repeat archive builds skip the signing-asset scan.",
  },
  {
    number: 39,
    repository: "web-app",
    title: "Upgrade the design system to v4",
    author: "priya-nair",
    state: "MERGED",
    isDraft: false,
    reviewDecision: "APPROVED",
    rollup: "SUCCESS",
    labels: ["frontend", "dependencies"],
    additions: 1284,
    deletions: 1102,
    changedFiles: 63,
    commits: 18,
    updatedMinutesAgo: 60 * 26,
    createdMinutesAgo: 60 * 96,
    body: "Bumps the design system to v4 and migrates the deprecated token names.",
  },
  // The rest of the viewer's open pull requests. The Pull Requests page opens on the "Mine"
  // scope, which searches `author:@me is:open`, so these have to be OPEN and authored by the
  // viewer to show up there.
  {
    number: 38,
    repository: "web-app",
    title: "Persist recent quick-search selections per worktree",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    rollup: "SUCCESS",
    labels: ["frontend", "search"],
    additions: 168,
    deletions: 24,
    changedFiles: 7,
    commits: 3,
    updatedMinutesAgo: 140,
    createdMinutesAgo: 60 * 40,
    body: "Stores the last ten opened results per worktree so the palette opens on something useful.",
  },
  {
    number: 37,
    repository: "web-app",
    title: "Fix the checkout total after a promotion is removed",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "CHANGES_REQUESTED",
    rollup: "SUCCESS",
    labels: ["frontend", "checkout", "ACME-1231"],
    additions: 94,
    deletions: 61,
    changedFiles: 4,
    commits: 5,
    updatedMinutesAgo: 205,
    createdMinutesAgo: 60 * 45,
    body: "Recomputes the order total from the server cart rather than the local discount cache.\n\nCloses ACME-1231.",
  },
  {
    number: 36,
    repository: "web-app",
    title: "Version the analytics event payloads",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    rollup: "PENDING",
    labels: ["frontend", "telemetry"],
    additions: 322,
    deletions: 88,
    changedFiles: 12,
    commits: 6,
    updatedMinutesAgo: 48,
    createdMinutesAgo: 60 * 50,
    body: "Adds a schema version to every analytics event and validates payloads at the ingestion boundary.",
  },
  {
    number: 35,
    repository: "web-app",
    title: "Accessibility pass over checkout and catalog",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
    rollup: "FAILURE",
    labels: ["frontend", "accessibility"],
    additions: 246,
    deletions: 118,
    changedFiles: 19,
    commits: 9,
    updatedMinutesAgo: 320,
    createdMinutesAgo: 60 * 55,
    body: "Fixes focus order, contrast and the missing form labels. Draft until the axe run is clean.",
  },
  {
    number: 34,
    repository: "api",
    title: "Replay errored GitHub webhook deliveries",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "APPROVED",
    rollup: "SUCCESS",
    labels: ["backend", "github"],
    additions: 408,
    deletions: 52,
    changedFiles: 15,
    commits: 8,
    updatedMinutesAgo: 76,
    createdMinutesAgo: 60 * 60,
    body: "Persists the raw delivery payload and replays it through the same handler behind the delivery idempotency key.",
  },
  {
    number: 33,
    repository: "api",
    title: "Move the remaining list queries onto cursor pagination",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    rollup: "SUCCESS",
    labels: ["backend", "graphql"],
    additions: 536,
    deletions: 314,
    changedFiles: 28,
    commits: 12,
    updatedMinutesAgo: 168,
    createdMinutesAgo: 60 * 65,
    body: "Opaque cursors keyed on (createdAt, id). The offset arguments stay for one release.",
  },
  {
    number: 121,
    repository: "ios-app",
    title: "Cost-weighted LRU eviction for the cache store",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "CHANGES_REQUESTED",
    rollup: "SUCCESS",
    labels: ["ios", "performance"],
    additions: 294,
    deletions: 176,
    changedFiles: 11,
    commits: 7,
    updatedMinutesAgo: 260,
    createdMinutesAgo: 60 * 70,
    body: "Replaces the flat LRU with a cost-weighted policy and adds soft and hard size ceilings.",
  },
  {
    number: 120,
    repository: "ios-app",
    title: "Per-category push notification preferences",
    author: VIEWER_LOGIN,
    state: "OPEN",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    rollup: "PENDING",
    labels: ["ios", "notifications"],
    additions: 356,
    deletions: 42,
    changedFiles: 16,
    commits: 10,
    updatedMinutesAgo: 92,
    createdMinutesAgo: 60 * 75,
    body: "Preferences are stored server-side and mirrored into the APNs registration payload.",
  },
];

const pipelineContexts = (seed: PullRequestSeed) => {
  const base = `https://github.com/${OWNER}/${seed.repository}/actions/runs`;
  const conclusion = (fallback: string) =>
    seed.rollup === "FAILURE"
      ? "FAILURE"
      : seed.rollup === "PENDING"
        ? null
        : fallback;
  return [
    {
      __typename: "CheckRun",
      id: `CR_${seed.number}_build`,
      name: "Build",
      status: seed.rollup === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
      conclusion: seed.rollup === "PENDING" ? null : "SUCCESS",
      detailsUrl: `${base}/98765432${seed.number}`,
      startedAt: ago(seed.updatedMinutesAgo + 12),
      completedAt:
        seed.rollup === "PENDING" ? null : ago(seed.updatedMinutesAgo + 6),
      // Each check run needs its own check suite: the pipeline store keys records on
      // `CHECK_SUITE:<id>`, so a shared id makes two records collide on one unique row.
      checkSuite: {
        id: `CS_${seed.number}_build`,
        status: seed.rollup === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
        conclusion: seed.rollup === "PENDING" ? null : "SUCCESS",
        url: `${base}/98765432${seed.number}`,
        app: { name: "GitHub Actions", slug: "github-actions" },
        workflowRun: {
          databaseId: Number(`98765432${seed.number}`),
          runNumber: 412,
          runAttempt: 1,
          updatedAt: ago(seed.updatedMinutesAgo + 6),
          url: `${base}/98765432${seed.number}`,
          workflow: { name: "Build", databaseId: 1001 },
        },
      },
    },
    {
      __typename: "CheckRun",
      id: `CR_${seed.number}_test`,
      name: "Test",
      status: seed.rollup === "PENDING" ? "QUEUED" : "COMPLETED",
      conclusion: conclusion("SUCCESS"),
      detailsUrl: `${base}/98765433${seed.number}`,
      startedAt: ago(seed.updatedMinutesAgo + 12),
      completedAt:
        seed.rollup === "PENDING" ? null : ago(seed.updatedMinutesAgo + 4),
      checkSuite: {
        id: `CS_${seed.number}_test`,
        status: seed.rollup === "PENDING" ? "QUEUED" : "COMPLETED",
        conclusion: conclusion("SUCCESS"),
        url: `${base}/98765433${seed.number}`,
        app: { name: "GitHub Actions", slug: "github-actions" },
        workflowRun: {
          databaseId: Number(`98765433${seed.number}`),
          runNumber: 412,
          runAttempt: 1,
          updatedAt: ago(seed.updatedMinutesAgo + 4),
          url: `${base}/98765433${seed.number}`,
          workflow: { name: "Test", databaseId: 1002 },
        },
      },
    },
    {
      __typename: "StatusContext",
      id: `SC_${seed.number}_lint`,
      context: "lint/eslint",
      state: seed.rollup === "PENDING" ? "PENDING" : "SUCCESS",
      description: "No lint errors",
      targetUrl: `${base}/98765434${seed.number}`,
      createdAt: ago(seed.updatedMinutesAgo + 10),
      updatedAt: ago(seed.updatedMinutesAgo + 3),
    },
  ];
};

const reviewThreadComment = (
  id: string,
  author: string,
  body: string,
  minutesAgo: number,
  pullNumber: number,
  repository: string,
) => ({
  id,
  body,
  bodyText: body,
  bodyHTML: `<p>${body}</p>`,
  url: `https://github.com/${OWNER}/${repository}/pull/${pullNumber}#discussion_r${id}`,
  author: actor(author),
  createdAt: ago(minutesAgo),
  updatedAt: ago(minutesAgo),
});

/**
 * Every review thread carries the pull request it belongs to — the Comments page groups by it,
 * and the detail page reads `headRepository` off it to match the thread to a local worktree.
 */
const threadPullRequest = (seed: PullRequestSeed) => ({
  id: `PR_${seed.repository}_${seed.number}`,
  number: seed.number,
  title: seed.title,
  url: `https://github.com/${OWNER}/${seed.repository}/pull/${seed.number}`,
  headRefName: `feature/pr-${seed.number}`,
  headRepository: { nameWithOwner: `${OWNER}/${seed.repository}` },
  repository: { nameWithOwner: `${OWNER}/${seed.repository}` },
});

/**
 * Thread content is keyed by pull request so each comment reads like a review of that PR's
 * actual diff, rather than the same generic remark repeated across unrelated repositories.
 */
const THREAD_CONTENT: Record<
  number,
  Array<{
    path: string;
    line: number;
    startLine: number | null;
    resolved: boolean;
    comments: Array<[author: string, body: string, minutesAgo: number]>;
  }>
> = {
  42: [
    {
      path: "src/components/search/quick-search.tsx",
      line: 142,
      startLine: null,
      resolved: false,
      comments: [
        [
          "john-smith",
          "This debounce is recreated on every render — move it into a ref so typing does not reset the timer.",
          38,
        ],
        [
          VIEWER_LOGIN,
          "Good catch. Switching to a ref and clearing it on unmount.",
          26,
        ],
      ],
    },
    {
      path: "src/components/search/result-list.tsx",
      line: 88,
      startLine: 84,
      resolved: false,
      comments: [
        [
          "priya-nair",
          "Result rows need an accessible name — screen readers announce these as blank list items today.",
          52,
        ],
      ],
    },
    {
      path: "src/lib/telemetry.ts",
      line: 31,
      startLine: null,
      resolved: true,
      comments: [
        [
          "sam-rivera",
          "Prefer the shared event name constant here so the dashboards keep matching.",
          140,
        ],
      ],
    },
  ],
  40: [
    {
      path: "src/auth/device_authorization.py",
      line: 96,
      startLine: null,
      resolved: false,
      comments: [
        [
          "john-smith",
          "The polling interval comes straight from the client. Clamp it to the value we returned, or a client can hammer this endpoint.",
          44,
        ],
        [
          VIEWER_LOGIN,
          "Agreed — clamping to the advertised interval and returning slow_down past that.",
          20,
        ],
      ],
    },
    {
      path: "src/auth/device_codes.py",
      line: 54,
      startLine: null,
      resolved: true,
      comments: [
        [
          "priya-nair",
          "User codes should avoid visually ambiguous characters; drop O, 0, I and 1 from the alphabet.",
          200,
        ],
      ],
    },
  ],
};

const reviewThreads = (seed: PullRequestSeed) => {
  const content = THREAD_CONTENT[seed.number];
  if (!content) return [];
  const pullRequest = threadPullRequest(seed);
  return content.map((thread, index) => ({
    id: `RT_${seed.number}_${index + 1}`,
    pullRequest,
    isResolved: thread.resolved,
    isOutdated: false,
    subjectType: "LINE",
    path: thread.path,
    line: thread.line,
    startLine: thread.startLine,
    originalLine: thread.line,
    originalStartLine: thread.startLine,
    viewerCanReply: true,
    viewerCanResolve: !thread.resolved,
    viewerCanUnresolve: thread.resolved,
    resolvedBy: thread.resolved ? actor(VIEWER_LOGIN) : null,
    comments: connection(
      thread.comments.map(([author, body, minutesAgo], commentIndex) =>
        reviewThreadComment(
          `${seed.number}00${index}${commentIndex}`,
          author,
          body,
          minutesAgo,
          seed.number,
          seed.repository,
        ),
      ),
    ),
  }));
};

const pullRequestNode = (seed: PullRequestSeed) => ({
  __typename: "PullRequest",
  id: `PR_${seed.repository}_${seed.number}`,
  number: seed.number,
  title: seed.title,
  url: `https://github.com/${OWNER}/${seed.repository}/pull/${seed.number}`,
  createdAt: ago(seed.createdMinutesAgo),
  updatedAt: ago(seed.updatedMinutesAgo),
  state: seed.state,
  mergedAt: seed.state === "MERGED" ? ago(seed.updatedMinutesAgo) : null,
  headRefName: `feature/pr-${seed.number}`,
  headRefOid: `${seed.number}`.padStart(4, "0").repeat(10).slice(0, 40),
  headRepository: { nameWithOwner: `${OWNER}/${seed.repository}` },
  repository: repositoryNode(seed.repository),
  labels: connection(seed.labels.map((name) => ({ name }))),
  statusCheckRollup: {
    state: seed.rollup,
    contexts: connection(pipelineContexts(seed)),
  },
  reviewDecision: seed.reviewDecision,
  isDraft: seed.isDraft,
  mergeable: seed.rollup === "FAILURE" ? "CONFLICTING" : "MERGEABLE",
  mergeStateStatus: seed.rollup === "FAILURE" ? "BLOCKED" : "CLEAN",
  autoMergeRequest: null,
  viewerCanEnableAutoMerge: seed.state === "OPEN",
  viewerCanDisableAutoMerge: false,
  reviewThreads: connection(
    reviewThreads(seed).map((thread) => ({ isResolved: thread.isResolved })),
  ),
  author: actor(seed.author),
  assignees: connection([actor(seed.author)]),
  body: seed.body,
  bodyHTML: seed.body
    .split("\n\n")
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br />")}</p>`)
    .join(""),
  baseRefName: "main",
  additions: seed.additions,
  deletions: seed.deletions,
  changedFiles: seed.changedFiles,
  commits: { totalCount: seed.commits },
});

const openPullRequests = PULL_REQUESTS.filter((seed) => seed.state === "OPEN");

/** GitHub search strings are matched loosely — enough to vary results per saved scope. */
function pullRequestsForSearch(query: string): PullRequestSeed[] {
  const lower = query.toLowerCase();
  let results = openPullRequests;
  if (lower.includes("is:merged")) {
    results = PULL_REQUESTS.filter((seed) => seed.state === "MERGED");
  }
  if (
    lower.includes(`author:${VIEWER_LOGIN}`) ||
    lower.includes("author:@me")
  ) {
    results = results.filter((seed) => seed.author === VIEWER_LOGIN);
  }
  if (lower.includes("review-requested:") || lower.includes("reviewed-by:")) {
    results = results.filter((seed) => seed.author !== VIEWER_LOGIN);
  }
  const repository = REPOS.find((name) =>
    lower.includes(`repo:${OWNER}/${name}`.toLowerCase()),
  );
  if (repository)
    results = results.filter((seed) => seed.repository === repository);
  return results;
}

function graphqlData(query: string, variables: Record<string, unknown>) {
  const data: Record<string, unknown> = {};

  if (/\bviewer\s*{/.test(query)) data.viewer = { login: VIEWER_LOGIN };

  // Batched searches arrive as search0/search1/… aliases; a single search keeps the bare name.
  const searchAliases = [...query.matchAll(/(search\d*)\s*:?\s*search?\s*\(/g)]
    .map((match) => match[1]!)
    .filter((alias, index, all) => all.indexOf(alias) === index);
  const aliases = searchAliases.length
    ? searchAliases
    : /\bsearch\s*\(/.test(query)
      ? ["search"]
      : [];
  for (const alias of aliases) {
    const index = alias === "search" ? "" : alias.slice("search".length);
    const searchQuery = String(variables[`query${index}`] ?? "");
    data[alias] = connection(
      pullRequestsForSearch(searchQuery).map(pullRequestNode),
    );
  }

  // Every `repository(owner:…)` selection gets the same superset object. Matching on operation
  // name instead would silently return an empty repository for any query not listed, which
  // surfaces as an unrelated "cannot read property of undefined" much further downstream.
  if (/\brepository\s*\(\s*owner\s*:/.test(query)) {
    const name = String(variables.name ?? REPOS[0]);
    const number = Number(variables.number);
    const seed =
      PULL_REQUESTS.find((item) => item.number === number) ??
      PULL_REQUESTS.find((item) => item.repository === name) ??
      PULL_REQUESTS[0]!;
    data.repository = {
      ...repositoryNode(name),
      name,
      owner: { login: OWNER },
      description: `Acme ${name}`,
      defaultBranchRef: { name: "main" },
      mergeCommitAllowed: true,
      rebaseMergeAllowed: true,
      squashMergeAllowed: true,
      viewerPermission: "ADMIN",
      pullRequest: {
        ...pullRequestNode(seed),
        reviewThreads: connection(reviewThreads(seed)),
      },
      pullRequests: connection(
        PULL_REQUESTS.filter((item) => item.repository === name).map(
          pullRequestNode,
        ),
      ),
    };
  }

  if (/\bviewer\s*{[^}]*email/.test(query)) {
    data.viewer = { login: VIEWER_LOGIN, email: "jane.doe@acme.example.com" };
  }

  if (/query GitHubAvailableRepositories/.test(query)) {
    data.viewer = {
      login: VIEWER_LOGIN,
      repositories: connection(
        REPOS.map((name) => ({
          ...repositoryNode(name),
          name,
          owner: { login: OWNER },
          isArchived: false,
          viewerPermission: "ADMIN",
        })),
      ),
    };
  }

  // `node(id:)` is how the Comments page pulls the review threads for one pull request, and
  // how label / pipeline-context pagination follows up on a truncated connection.
  if (/\bnode\s*\(\s*id\s*:/.test(query)) {
    const id = String(variables.id ?? "");
    const seed =
      PULL_REQUESTS.find((item) => id.endsWith(`_${item.number}`)) ??
      PULL_REQUESTS[0]!;
    const node: Record<string, unknown> = { id };
    if (/reviewThreads\s*\(/.test(query)) {
      node.reviewThreads = connection(reviewThreads(seed));
    }
    if (/\blabels\s*\(/.test(query)) {
      node.labels = connection(seed.labels.map((name) => ({ name })));
    }
    if (/statusCheckRollup/.test(query)) {
      node.statusCheckRollup = {
        state: seed.rollup,
        contexts: connection(pipelineContexts(seed)),
      };
    }
    if (/\bcomments\s*\(/.test(query)) {
      const thread = reviewThreads(seed).find((item) => item.id === id);
      node.comments = thread?.comments ?? connection([]);
    }
    data.node = node;
  }

  // `nodes(ids:)` is keyed by *pull request* id and must answer with the pull request's thread
  // connection — not the threads themselves.
  if (/\bnodes\s*\(\s*ids\s*:/.test(query)) {
    const ids = (variables.ids as string[] | undefined) ?? [];
    data.nodes = ids.map((id) => {
      const seed = PULL_REQUESTS.find(
        (item) => `PR_${item.repository}_${item.number}` === id,
      );
      if (!seed) return null;
      return { id, reviewThreads: connection(reviewThreads(seed)) };
    });
  }

  return data;
}

/** Fixed rate-limit block so the cache layer records realistic point costs. */
const RATE_LIMIT = {
  cost: 1,
  limit: 5000,
  remaining: 4993,
  used: 7,
  resetAt: ago(-45),
};

function githubGraphql(body: {
  query?: string;
  variables?: Record<string, unknown>;
}) {
  const query = body.query ?? "";
  const variables = body.variables ?? {};
  const data = graphqlData(query, variables);
  // The service injects an aliased `_adeRateLimit { cost }` selection into every query.
  if (/_adeRateLimit/.test(query)) {
    (data as Record<string, unknown>)._adeRateLimit = { cost: RATE_LIMIT.cost };
  }
  if (!Object.keys(data).length) {
    console.warn(
      `[mock-api] unhandled GitHub GraphQL operation:\n${query.slice(0, 300)}`,
    );
  }
  return { data };
}

const WORKFLOW_RUNS = REPOS.flatMap((repository, repositoryIndex) =>
  [
    { name: "Build", conclusion: "success", event: "push" },
    {
      name: "Test",
      conclusion: repositoryIndex === 0 ? "failure" : "success",
      event: "pull_request",
    },
    { name: "Lint", conclusion: "success", event: "push" },
    {
      name: "Release",
      conclusion: repositoryIndex === 1 ? "cancelled" : "success",
      event: "workflow_dispatch",
    },
  ].map((workflow, index) => {
    const id = Number(`${98765430 + repositoryIndex * 10 + index}`);
    return {
      id,
      name: workflow.name,
      node_id: `WFR_${id}`,
      head_branch: index % 2 === 0 ? "main" : `feature/pr-${40 + index}`,
      head_sha: `${id}`.repeat(6).slice(0, 40),
      path: `.github/workflows/${workflow.name.toLowerCase()}.yml`,
      display_title: `${workflow.name} on ${OWNER}/${repository}`,
      run_number: 412 - index,
      run_attempt: 1,
      event: workflow.event,
      status: "completed",
      conclusion: workflow.conclusion,
      // Required by the Actions run mapping; a missing check suite node id makes the run
      // un-retryable and a missing repository node_id throws while normalizing.
      check_suite_node_id: `CS_run_${id}`,
      workflow_id: 1000 + index,
      url: `https://api.github.com/repos/${OWNER}/${repository}/actions/runs/${id}`,
      html_url: `https://github.com/${OWNER}/${repository}/actions/runs/${id}`,
      created_at: ago(60 * (index + 1) + repositoryIndex * 15),
      updated_at: ago(60 * (index + 1) + repositoryIndex * 15 - 6),
      run_started_at: ago(60 * (index + 1) + repositoryIndex * 15),
      actor: {
        login: VIEWER_LOGIN,
        avatar_url: avatarFor(VIEWER_LOGIN),
        html_url: `https://github.com/${VIEWER_LOGIN}`,
      },
      triggering_actor: {
        login: VIEWER_LOGIN,
        avatar_url: avatarFor(VIEWER_LOGIN),
        html_url: `https://github.com/${VIEWER_LOGIN}`,
      },
      pull_requests:
        index % 2 === 0
          ? []
          : [{ number: 42, id: 1, url: "", head: {}, base: {} }],
      repository: {
        id: 10 + repositoryIndex,
        node_id: repositoryNode(repository).id,
        name: repository,
        full_name: `${OWNER}/${repository}`,
        html_url: `https://github.com/${OWNER}/${repository}`,
        owner: { login: OWNER, avatar_url: avatarFor(OWNER) },
      },
      head_repository: {
        id: 10 + repositoryIndex,
        node_id: repositoryNode(repository).id,
        name: repository,
        full_name: `${OWNER}/${repository}`,
      },
    };
  }),
);

const workflowJobs = (runId: number) =>
  [
    { name: "setup", conclusion: "success" },
    { name: "build", conclusion: "success" },
    { name: "test", conclusion: runId % 2 === 0 ? "success" : "failure" },
  ].map((job, index) => ({
    id: runId * 10 + index,
    run_id: runId,
    run_attempt: 1,
    name: job.name,
    status: "completed",
    conclusion: job.conclusion,
    started_at: ago(70 - index * 2),
    completed_at: ago(66 - index * 2),
    html_url: `https://github.com/${OWNER}/web-app/actions/runs/${runId}/job/${runId * 10 + index}`,
    steps: [
      {
        number: 1,
        name: "Set up job",
        status: "completed",
        conclusion: "success",
        started_at: ago(70 - index * 2),
        completed_at: ago(69 - index * 2),
      },
      {
        number: 2,
        name: `Run ${job.name}`,
        status: "completed",
        conclusion: job.conclusion,
        started_at: ago(69 - index * 2),
        completed_at: ago(66 - index * 2),
      },
    ],
  }));

/** GitHub Actions cache server (a separate service, addressed by CacheServerSettings.baseUrl). */
const CACHE_ENTRIES = [
  ["node-modules", "npm-lock-8f2a1c", "refs/heads/main", "web-app"],
  ["next-build", "next-14-2b91de", "refs/heads/main", "web-app"],
  ["turbo-cache", "turbo-3c77ab", "refs/heads/main", "web-app"],
  ["swift-packages", "spm-resolved-91ce40", "refs/heads/main", "ios-app"],
  ["derived-data", "xcode-16-4-77aa02", "refs/heads/main", "ios-app"],
  ["cargo-registry", "cargo-lock-51bd93", "refs/heads/main", "api"],
  ["pip-wheels", "requirements-2ad4f8", "refs/heads/main", "api"],
  ["playwright-browsers", "pw-1-62-0-4de118", "refs/pull/42/merge", "web-app"],
].map(([key, version, scope, repository], index) => ({
  id: `cache-entry-${index + 1}`,
  key: `${key}-${version}`,
  version,
  scope: scope!,
  repoId: `${10 + (["web-app", "ios-app", "api"] as string[]).indexOf(repository!)}`,
  updatedAt: Date.parse(ago(30 * (index + 1))),
  locationId: `location-${index + 1}`,
}));

function cacheServerRest(path: string, search: URLSearchParams): unknown {
  if (path === "/cache-entries") {
    const key = search.get("key")?.trim();
    const repoId = search.get("repoId")?.trim();
    const perPage = Number(search.get("itemsPerPage") ?? 20);
    let items = CACHE_ENTRIES;
    if (key) items = items.filter((entry) => entry.key.includes(key));
    if (repoId) items = items.filter((entry) => entry.repoId === repoId);
    return { total: items.length, items: items.slice(0, perPage) };
  }

  if (path === "/cache-entries/match") {
    return { match: CACHE_ENTRIES[0], type: "EXACT_PRIMARY" };
  }

  const entryMatch = path.match(/^\/cache-entries\/([^/]+)$/);
  if (entryMatch) {
    const id = decodeURIComponent(entryMatch[1]!);
    return CACHE_ENTRIES.find((entry) => entry.id === id) ?? CACHE_ENTRIES[0];
  }

  const locationMatch = path.match(/^\/storage-locations\/([^/]+)$/);
  if (locationMatch) {
    const id = decodeURIComponent(locationMatch[1]!);
    return {
      id,
      folderName: `blobs/${id}`,
      partCount: 4,
      mergeStartedAt: Date.parse(ago(90)),
      mergedAt: Date.parse(ago(88)),
      partsDeletedAt: Date.parse(ago(87)),
      lastDownloadedAt: Date.parse(ago(12)),
      sizeBytes: 184_320_000,
    };
  }

  console.warn(`[mock-api] unhandled cache server path: ${path}`);
  return {};
}

function githubRest(pathname: string, search: URLSearchParams): unknown {
  if (pathname.startsWith("/cache-server/")) {
    return cacheServerRest(pathname.slice("/cache-server".length), search);
  }

  const runsMatch = pathname.match(
    /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/?$/,
  );
  if (runsMatch) {
    const repository = runsMatch[2]!;
    const runs = WORKFLOW_RUNS.filter(
      (run) => run.repository.name === repository,
    );
    const page = Number(search.get("page") ?? 1);
    return {
      total_count: runs.length,
      workflow_runs: page > 1 ? [] : runs,
    };
  }

  // Single workflow run. The pull request pipeline store reads `updated_at` off this payload,
  // so an unhandled path here becomes an "Invalid Date" write and fails the whole page.
  const runMatch = pathname.match(
    /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/?$/,
  );
  if (runMatch) {
    const repository = runMatch[2]!;
    const id = Number(runMatch[3]);
    const known = WORKFLOW_RUNS.find((run) => run.id === id);
    if (known) return known;
    // Check-suite ids derived from a pull request do not appear in the listing above; answer
    // with a run shaped the same way so the pipeline record still gets valid timestamps.
    const template = WORKFLOW_RUNS[0]!;
    return {
      ...template,
      id,
      node_id: `WFR_${id}`,
      url: `https://api.github.com/repos/${OWNER}/${repository}/actions/runs/${id}`,
      html_url: `https://github.com/${OWNER}/${repository}/actions/runs/${id}`,
      repository: {
        ...template.repository,
        name: repository,
        full_name: `${OWNER}/${repository}`,
        html_url: `https://github.com/${OWNER}/${repository}`,
      },
      head_repository: {
        ...template.head_repository,
        name: repository,
        full_name: `${OWNER}/${repository}`,
      },
    };
  }

  const jobsMatch = pathname.match(
    /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs\/?$/,
  );
  if (jobsMatch) {
    const jobs = workflowJobs(Number(jobsMatch[1]));
    const page = Number(search.get("page") ?? 1);
    return { total_count: jobs.length, jobs: page > 1 ? [] : jobs };
  }

  if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/pulls\/?$/.test(pathname)) {
    return [{ number: 42 }];
  }

  if (/^\/repos\/[^/]+\/[^/]+\/actions\/caches\/?$/.test(pathname)) {
    return { total_count: 0, actions_caches: [] };
  }

  if (pathname === "/user") {
    return { login: VIEWER_LOGIN, id: 1, avatar_url: AVATAR };
  }

  console.warn(`[mock-api] unhandled GitHub REST path: ${pathname}`);
  return {};
}

const JIRA_STATUSES = [
  { id: "10000", name: "To Do", key: "new" },
  { id: "10001", name: "In Progress", key: "indeterminate" },
  { id: "10003", name: "Done", key: "done" },
];

type JiraSeed = {
  key: string;
  summary: string;
  status: (typeof JIRA_STATUSES)[number];
  type: string;
  priority: string;
  assignee: string;
  labels: string[];
  storyPoints: number;
  description: string;
};

const JIRA_ISSUES: JiraSeed[] = [
  {
    key: "ACME-1234",
    summary: "Add quick search to the global navigation bar",
    status: JIRA_STATUSES[1]!,
    type: "Story",
    priority: "High",
    assignee: "Jane Doe",
    labels: ["frontend", "search"],
    storyPoints: 5,
    description:
      "Users cannot jump between codebases, runs and pull requests without leaving the page they are on. Add a command-palette style quick search to the global navigation bar.",
  },
  {
    key: "ACME-1240",
    summary: "Add the OAuth 2.0 device authorization flow to the API",
    status: JIRA_STATUSES[1]!,
    type: "Story",
    priority: "High",
    assignee: "Jane Doe",
    labels: ["backend", "auth"],
    storyPoints: 8,
    description:
      "Support RFC 8628 so the CLI and the iOS app can authenticate without an embedded browser.",
  },
  {
    key: "ACME-1231",
    summary: "Checkout total is wrong when a promotion is removed",
    status: JIRA_STATUSES[0]!,
    type: "Bug",
    priority: "Highest",
    assignee: "John Smith",
    labels: ["checkout", "regression"],
    storyPoints: 3,
    description:
      "Removing a promotion code leaves the discount applied to the order total until the cart is reloaded.",
  },
  {
    key: "ACME-1228",
    summary: "Cache provisioning profiles between archive builds",
    status: JIRA_STATUSES[0]!,
    type: "Task",
    priority: "Medium",
    assignee: "Sam Rivera",
    labels: ["ios", "build"],
    storyPoints: 2,
    description:
      "Archive builds re-scan signing assets on every run, adding about ninety seconds to each build.",
  },
  {
    key: "ACME-1225",
    summary: "Upgrade the design system to v4",
    status: JIRA_STATUSES[2]!,
    type: "Task",
    priority: "Medium",
    assignee: "Priya Nair",
    labels: ["frontend", "dependencies"],
    storyPoints: 5,
    description: "Migrate the deprecated token names introduced by v4.",
  },
];

const JIRA_LINK_TYPES = {
  relates: {
    id: "10003",
    name: "Relates",
    outward: "relates to",
    inward: "relates to",
  },
  blocks: {
    id: "10000",
    name: "Blocks",
    outward: "blocks",
    inward: "is blocked by",
  },
  duplicates: {
    id: "10002",
    name: "Duplicate",
    outward: "duplicates",
    inward: "is duplicated by",
  },
} as const;

/**
 * Related issues per key. `direction` says which side of the link this issue is on, which is
 * what picks the relationship wording the ticket detail's Related issues panel shows: an
 * `outward` blocks link reads "blocks", the `inward` one reads "is blocked by".
 */
const JIRA_LINKS: Record<
  string,
  Array<{
    type: keyof typeof JIRA_LINK_TYPES;
    direction: "outward" | "inward";
    key: string;
  }>
> = {
  "ACME-1234": [
    { type: "blocks", direction: "outward", key: "ACME-1231" },
    { type: "relates", direction: "outward", key: "ACME-1240" },
    { type: "blocks", direction: "inward", key: "ACME-1225" },
  ],
  "ACME-1240": [
    { type: "relates", direction: "inward", key: "ACME-1234" },
    { type: "relates", direction: "outward", key: "ACME-1228" },
  ],
  "ACME-1231": [{ type: "blocks", direction: "inward", key: "ACME-1234" }],
  "ACME-1228": [
    { type: "relates", direction: "inward", key: "ACME-1240" },
    { type: "duplicates", direction: "outward", key: "ACME-1225" },
  ],
  "ACME-1225": [
    { type: "blocks", direction: "outward", key: "ACME-1234" },
    { type: "duplicates", direction: "inward", key: "ACME-1228" },
  ],
};

function jiraLinksFor(key: string) {
  return (JIRA_LINKS[key] ?? []).flatMap((link, index) => {
    const target = JIRA_ISSUES.find((issue) => issue.key === link.key);
    if (!target) return [];
    const node = {
      id: `20${index}${target.key.slice(-4)}`,
      key: target.key,
      self: `https://jira.local/rest/api/3/issue/${target.key}`,
      fields: {
        summary: target.summary,
        status: {
          id: target.status.id,
          name: target.status.name,
          statusCategory: { key: target.status.key, name: target.status.name },
        },
        priority: { id: "2", name: target.priority, iconUrl: AVATAR },
        issuetype: {
          id: "10001",
          name: target.type,
          iconUrl: AVATAR,
          subtask: false,
        },
      },
    };
    return [
      {
        id: `30${index}${target.key.slice(-4)}`,
        type: JIRA_LINK_TYPES[link.type],
        ...(link.direction === "outward"
          ? { outwardIssue: node }
          : { inwardIssue: node }),
      },
    ];
  });
}

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const jiraUser = (displayName: string) => ({
  accountId: displayName.toLowerCase().replace(/\s+/g, "-"),
  displayName,
  emailAddress: `${displayName.toLowerCase().replace(/\s+/g, ".")}@acme.example.com`,
  active: true,
  avatarUrls: {
    "48x48": avatarFor(displayName),
    "24x24": avatarFor(displayName),
  },
});

const jiraIssue = (seed: JiraSeed, index: number) => ({
  id: `1000${index}`,
  key: seed.key,
  self: `https://jira.local/rest/api/3/issue/${seed.key}`,
  fields: {
    summary: seed.summary,
    description: adf(seed.description),
    status: {
      id: seed.status.id,
      name: seed.status.name,
      statusCategory: { key: seed.status.key, name: seed.status.name },
    },
    issuetype: {
      id: "10001",
      name: seed.type,
      iconUrl: AVATAR,
      subtask: false,
    },
    priority: { id: "2", name: seed.priority, iconUrl: AVATAR },
    assignee: jiraUser(seed.assignee),
    reporter: jiraUser("John Smith"),
    creator: jiraUser("John Smith"),
    labels: seed.labels,
    created: ago(60 * 24 * (index + 3)),
    updated: ago(60 * (index + 2)),
    duedate: null,
    resolution:
      seed.status.key === "done" ? { id: "10000", name: "Done" } : null,
    project: {
      id: "10042",
      key: "ACME",
      name: "Acme Platform",
      avatarUrls: { "48x48": AVATAR },
    },
    customfield_10016: seed.storyPoints,
    comment: {
      total: 2,
      startAt: 0,
      maxResults: 2,
      comments: [
        {
          id: `${index}001`,
          author: jiraUser("John Smith"),
          body: adf(
            "Design review is done — the result grouping matches the latest mockups.",
          ),
          created: ago(60 * 6),
          updated: ago(60 * 6),
        },
        {
          id: `${index}002`,
          author: jiraUser("Jane Doe"),
          body: adf("Thanks — pushing the accessibility fixes next."),
          created: ago(60 * 2),
          updated: ago(60 * 2),
        },
      ],
    },
    worklog: { total: 0, startAt: 0, maxResults: 0, worklogs: [] },
    attachment: [],
    subtasks: [],
    issuelinks: jiraLinksFor(seed.key),
  },
});

const JIRA_ISSUE_PAYLOADS = JIRA_ISSUES.map(jiraIssue);

function jiraRest(pathname: string, search: URLSearchParams): unknown {
  const path = pathname.replace(/^\/rest\/(api|agile)\/[^/]+/, "");

  if (path === "/myself") return jiraUser("Jane Doe");

  if (path === "/project/search") {
    return {
      isLast: true,
      total: 1,
      values: [
        {
          id: "10042",
          key: "ACME",
          name: "Acme Platform",
          avatarUrls: { "48x48": AVATAR },
          projectTypeKey: "software",
        },
      ],
    };
  }

  if (/^\/project\/[^/]+\/statuses$/.test(path)) {
    return [
      {
        id: "10001",
        name: "Story",
        statuses: JIRA_STATUSES.map((status) => ({
          id: status.id,
          name: status.name,
          statusCategory: { key: status.key, name: status.name },
        })),
      },
    ];
  }

  if (/^\/project\/[^/]+$/.test(path)) {
    return {
      id: "10042",
      key: "ACME",
      name: "Acme Platform",
      avatarUrls: { "48x48": AVATAR },
    };
  }

  if (path === "/search" || path === "/search/jql") {
    const maxResults = Number(search.get("maxResults") ?? 50);
    return {
      startAt: 0,
      maxResults,
      total: JIRA_ISSUE_PAYLOADS.length,
      isLast: true,
      issues: JIRA_ISSUE_PAYLOADS.slice(0, maxResults),
    };
  }

  const issueMatch = path.match(/^\/issue\/([^/]+)$/);
  if (issueMatch) {
    const key = decodeURIComponent(issueMatch[1]!);
    return (
      JIRA_ISSUE_PAYLOADS.find((issue) => issue.key === key) ??
      JIRA_ISSUE_PAYLOADS[0]
    );
  }

  const commentMatch = path.match(/^\/issue\/([^/]+)\/comment$/);
  if (commentMatch) {
    const key = decodeURIComponent(commentMatch[1]!);
    const issue =
      JIRA_ISSUE_PAYLOADS.find((item) => item.key === key) ??
      JIRA_ISSUE_PAYLOADS[0]!;
    return { ...issue.fields.comment, startAt: 0, maxResults: 50 };
  }

  if (/^\/issue\/[^/]+\/transitions$/.test(path)) {
    return {
      transitions: JIRA_STATUSES.map((status, index) => ({
        id: `${21 + index}`,
        name: status.name,
        to: {
          id: status.id,
          name: status.name,
          statusCategory: { key: status.key, name: status.name },
        },
      })),
    };
  }

  if (/^\/issue\/[^/]+\/changelog$/.test(path)) {
    return {
      isLast: true,
      startAt: 0,
      maxResults: 50,
      total: 1,
      values: [
        {
          id: "10100",
          author: jiraUser("Jane Doe"),
          created: ago(60 * 5),
          items: [
            {
              field: "status",
              fieldtype: "jira",
              fromString: "To Do",
              toString: "In Progress",
            },
          ],
        },
      ],
    };
  }

  if (/^\/issue\/[^/]+\/worklog$/.test(path)) {
    return { startAt: 0, maxResults: 50, total: 0, worklogs: [] };
  }

  if (/^\/issue\/[^/]+\/editmeta$/.test(path)) {
    return { fields: {} };
  }

  if (/^\/user\/assignable\/search/.test(path)) {
    return [
      jiraUser("Jane Doe"),
      jiraUser("John Smith"),
      jiraUser("Sam Rivera"),
    ];
  }

  if (path === "/board" || /^\/board\b/.test(path)) {
    return {
      isLast: true,
      startAt: 0,
      maxResults: 50,
      total: 1,
      values: [{ id: 12, name: "Acme Platform Board", type: "scrum" }],
    };
  }

  if (path === "/field") {
    return [
      {
        id: "customfield_10016",
        name: "Story Points",
        custom: true,
        schema: { type: "number" },
      },
    ];
  }

  console.warn(`[mock-api] unhandled Jira path: ${pathname}`);
  return {};
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const server = createServer(
  async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const raw = await readBody(request);

    let payload: unknown = {};
    let status = 200;
    try {
      if (url.pathname === "/graphql") {
        payload = githubGraphql(raw ? JSON.parse(raw) : {});
      } else if (url.pathname.startsWith("/rest/")) {
        payload = jiraRest(url.pathname, url.searchParams);
      } else {
        payload = githubRest(url.pathname, url.searchParams);
      }
    } catch (error) {
      // A throw here is a bug in this stub, not a scenario under test. Answering 200 with an
      // empty body would render as an innocuous "no data" state and hide it, so surface a 5xx
      // that the capture assertions and the app's own error handling can both see.
      console.error(`[mock-api] ${url.pathname} failed:`, error);
      status = 500;
      payload = {
        message: `Mock API handler for ${url.pathname} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const body = JSON.stringify(payload ?? {});
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      // Mirror GitHub's rate-limit headers so the app records realistic telemetry.
      "x-ratelimit-limit": String(RATE_LIMIT.limit),
      "x-ratelimit-remaining": String(RATE_LIMIT.remaining),
      "x-ratelimit-used": String(RATE_LIMIT.used),
      "x-ratelimit-reset": String(
        Math.floor(Date.parse(RATE_LIMIT.resetAt) / 1000),
      ),
      "x-ratelimit-resource": url.pathname === "/graphql" ? "graphql" : "core",
      "x-github-request-id": "MOCK:0000:0000",
    });
    response.end(body);
  },
);

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Mock GitHub/Jira API server listening on http://127.0.0.1:${PORT}`,
  );
});
