import "server-only";

import { getPrismaClient } from "@/data/prisma-client";

export type GlobalSearchGroup =
  | "WORKTREES"
  | "TICKETS"
  | "PULL_REQUESTS"
  | "REPOSITORIES"
  | "CODEBASES"
  | "WORKFLOWS"
  | "GITHUB_ACTIONS"
  | "BUILDS"
  | "AGENTS_JOBS"
  | "PLANS_SESSIONS"
  | "COMMANDS_RUNS"
  | "SKILLS"
  | "DEVICES_PROFILES";

export type GlobalSearchKind =
  | "WORKTREE"
  | "JIRA_TICKET"
  | "GITHUB_PULL_REQUEST"
  | "REPOSITORY"
  | "CODEBASE"
  | "WORKFLOW"
  | "WORKFLOW_RUN"
  | "GITHUB_ACTIONS_RUN"
  | "BUILD"
  | "AGENT"
  | "AGENT_JOB"
  | "PLAN"
  | "SESSION"
  | "COMMAND"
  | "COMMAND_RUN"
  | "SKILL"
  | "SKILL_GROUP"
  | "DEVICE"
  | "PROVISIONING_PROFILE";

export type GlobalSearchItem = {
  key: string;
  kind: GlobalSearchKind;
  group: GlobalSearchGroup;
  title: string;
  subtitle: string | null;
  href: string;
  status: string | null;
  updatedAt: string | null;
  children: GlobalSearchItem[];
};

type RankedItem = GlobalSearchItem & { score: number };

const MAX_QUERY_LENGTH = 200;
const CANDIDATE_LIMIT = 100;

const segment = (value: string) => encodeURIComponent(value);
const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function queryTokens(query: string): string[] {
  return normalized(query)
    .split(" ")
    .map((token) => token.replace(/^#/, ""))
    .filter(Boolean);
}

export function globalSearchScore(
  query: string,
  primary: string,
  identifiers: Array<string | number | null | undefined> = [],
  secondary: Array<string | number | null | undefined> = [],
): number | null {
  const needle = normalized(query).replace(/^#/, "");
  const tokens = queryTokens(query);
  if (!needle || tokens.length === 0) return null;
  const primaryValue = normalized(primary);
  const identifierValues = identifiers
    .filter(
      (value): value is string | number =>
        value !== null && value !== undefined,
    )
    .map((value) => normalized(String(value)).replace(/^#/, ""));
  const secondaryValues = secondary
    .filter(
      (value): value is string | number =>
        value !== null && value !== undefined,
    )
    .map((value) => normalized(String(value)));
  const corpus = [primaryValue, ...identifierValues, ...secondaryValues].join(
    " ",
  );
  if (!tokens.every((token) => corpus.includes(token))) return null;

  if (identifierValues.includes(needle)) return 1_000;
  if (primaryValue === needle) return 900;
  if (identifierValues.some((value) => value.startsWith(needle))) return 800;
  if (primaryValue.startsWith(needle)) return 700;
  if (primaryValue.includes(needle)) return 600;
  if (secondaryValues.some((value) => value.startsWith(needle))) return 500;
  if (corpus.includes(needle)) return 400;
  return 300 + tokens.filter((token) => primaryValue.includes(token)).length;
}

function ranked(
  item: Omit<GlobalSearchItem, "children"> & {
    children?: GlobalSearchItem[];
  },
  query: string,
  primary: string,
  identifiers: Array<string | number | null | undefined> = [],
  secondary: Array<string | number | null | undefined> = [],
): RankedItem | null {
  const score = globalSearchScore(query, primary, identifiers, secondary);
  return score === null
    ? null
    : { ...item, children: item.children ?? [], score };
}

function sortAndLimit(items: Array<RankedItem | null>, limit: number) {
  return items
    .filter((item): item is RankedItem => item !== null)
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      const recency = (right.updatedAt ?? "").localeCompare(
        left.updatedAt ?? "",
      );
      return recency || left.title.localeCompare(right.title);
    })
    .slice(0, limit);
}

function stripScore(item: RankedItem): GlobalSearchItem {
  const { score, ...result } = item;
  void score;
  return result;
}

function jsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function jiraSummary(value: string | null): {
  summary: string | null;
  status: string | null;
} {
  const issue = jsonRecord(value);
  const fields =
    issue.fields &&
    typeof issue.fields === "object" &&
    !Array.isArray(issue.fields)
      ? (issue.fields as Record<string, unknown>)
      : {};
  const status =
    fields.status &&
    typeof fields.status === "object" &&
    !Array.isArray(fields.status)
      ? (fields.status as Record<string, unknown>)
      : {};
  return {
    summary: typeof fields.summary === "string" ? fields.summary : null,
    status: typeof status.name === "string" ? status.name : null,
  };
}

function githubCanonicalOrigin(nameWithOwner: string): string {
  return `github.com/${nameWithOwner.toLocaleLowerCase()}`;
}

function relationSubtitle(
  values: Array<string | null | undefined>,
): string | null {
  const result = values.filter((value): value is string =>
    Boolean(value?.trim()),
  );
  return result.length ? result.join(" · ") : null;
}

export class GlobalSearchService {
  async search(
    queryValue: string,
    firstPerGroup = 5,
    relatedFirst = 3,
  ): Promise<{ items: GlobalSearchItem[] }> {
    const query = queryValue.trim();
    if (!query) return { items: [] };
    if (query.length > MAX_QUERY_LENGTH) {
      throw new Error(`query must be at most ${MAX_QUERY_LENGTH} characters`);
    }
    if (
      !Number.isInteger(firstPerGroup) ||
      firstPerGroup < 1 ||
      firstPerGroup > 10
    ) {
      throw new Error("firstPerGroup must be an integer from 1 to 10");
    }
    if (
      !Number.isInteger(relatedFirst) ||
      relatedFirst < 0 ||
      relatedFirst > 5
    ) {
      throw new Error("relatedFirst must be an integer from 0 to 5");
    }

    const prisma = await getPrismaClient();
    // Query the database with the most selective token, then apply the full
    // tokenized ranking locally so terms may match across different fields.
    const candidateQuery =
      [...queryTokens(query)].sort(
        (left, right) => right.length - left.length,
      )[0] ?? query;
    const numericQuery = Number(query.replace(/^#/, ""));
    const numberMatch = Number.isInteger(numericQuery) && numericQuery >= 0;

    const [
      agents,
      jobs,
      repositories,
      codebases,
      worktrees,
      builds,
      workflows,
      workflowRuns,
      tickets,
      pullRequests,
      pipelineRecords,
      agentRuns,
      commands,
      commandRuns,
      skills,
      skillGroups,
      devices,
      profiles,
    ] = await Promise.all([
      prisma.agent.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            { name: { contains: candidateQuery } },
            { hostname: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.agentJob.findMany({
        where: {
          visibility: "USER",
          OR: [
            { id: { contains: candidateQuery } },
            { kind: { contains: candidateQuery } },
            { status: { contains: candidateQuery } },
            { agent: { name: { contains: candidateQuery } } },
            { agent: { hostname: { contains: candidateQuery } } },
          ],
        },
        include: { agent: true },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.codebaseRepository.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            { name: { contains: candidateQuery } },
            { description: { contains: candidateQuery } },
            { canonicalOrigin: { contains: candidateQuery } },
            { displayOrigin: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.codebase.findMany({
        where: {
          availability: { not: "MISSING" },
          OR: [
            { id: { contains: candidateQuery } },
            { folder: { contains: candidateQuery } },
            { branch: { contains: candidateQuery } },
            { observedOrigin: { contains: candidateQuery } },
            { repository: { name: { contains: candidateQuery } } },
            { agent: { name: { contains: candidateQuery } } },
          ],
        },
        include: { repository: true, agent: true },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.worktree.findMany({
        where: {
          missingAt: null,
          availability: { not: "MISSING" },
          OR: [
            { id: { contains: candidateQuery } },
            { folder: { contains: candidateQuery } },
            { relativePath: { contains: candidateQuery } },
            { branch: { contains: candidateQuery } },
            {
              codebase: { repository: { name: { contains: candidateQuery } } },
            },
            { codebase: { agent: { name: { contains: candidateQuery } } } },
            { pullRequest: { title: { contains: candidateQuery } } },
            ...(numberMatch ? [{ pullRequest: { number: numericQuery } }] : []),
          ],
        },
        include: {
          codebase: { include: { repository: true, agent: true } },
          pullRequest: true,
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.build.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            { requestId: { contains: candidateQuery } },
            { status: { contains: candidateQuery } },
            { action: { contains: candidateQuery } },
            { commandSummary: { contains: candidateQuery } },
            { configuration: { name: { contains: candidateQuery } } },
            { worktree: { branch: { contains: candidateQuery } } },
            { worktree: { folder: { contains: candidateQuery } } },
            {
              codebase: { repository: { name: { contains: candidateQuery } } },
            },
          ],
        },
        include: {
          configuration: true,
          worktree: {
            include: { codebase: { include: { repository: true } } },
          },
          codebase: { include: { repository: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.workflow.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            { name: { contains: candidateQuery } },
            { description: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.workflowRun.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            ...(numberMatch ? [{ displayNumber: numericQuery }] : []),
            { status: { contains: candidateQuery } },
            { triggerSubjectKey: { contains: candidateQuery } },
            { workflow: { name: { contains: candidateQuery } } },
          ],
        },
        include: { workflow: true },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.jiraCachedTicket.findMany({
        where: {
          OR: [
            { issueKey: { contains: candidateQuery } },
            { projectKey: { contains: candidateQuery } },
            { summaryJson: { contains: candidateQuery } },
            { detailJson: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.worktreePullRequest.findMany({
        where: {
          worktree: { missingAt: null },
          OR: [
            { githubId: { contains: candidateQuery } },
            ...(numberMatch ? [{ number: numericQuery }] : []),
            { title: { contains: candidateQuery } },
            { repositoryNameWithOwner: { contains: candidateQuery } },
            { headRefName: { contains: candidateQuery } },
            { jiraKey: { contains: candidateQuery } },
          ],
        },
        include: { worktree: true },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.gitHubPipelineRecord.findMany({
        where: {
          isCurrent: true,
          workflowRunId: { not: null },
          OR: [
            { githubPipelineId: { contains: candidateQuery } },
            { workflowRunId: { contains: candidateQuery } },
            { workflowId: { contains: candidateQuery } },
            ...(numberMatch ? [{ runNumber: numericQuery }] : []),
            { name: { contains: candidateQuery } },
            { status: { contains: candidateQuery } },
            {
              snapshot: {
                repositoryNameWithOwner: { contains: candidateQuery },
              },
            },
          ],
        },
        include: { snapshot: true },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.agentRun.findMany({
        where: {
          kind: { in: ["PLAN", "SESSION"] },
          OR: [
            { id: { contains: candidateQuery } },
            ...(numberMatch ? [{ displayNumber: numericQuery }] : []),
            { initialPrompt: { contains: candidateQuery } },
            { repositoryName: { contains: candidateQuery } },
            { branch: { contains: candidateQuery } },
            { jiraIssueKey: { contains: candidateQuery } },
            { model: { contains: candidateQuery } },
            { status: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.commandDefinition.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            { name: { contains: candidateQuery } },
            { description: { contains: candidateQuery } },
            { script: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.commandRun.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            ...(numberMatch ? [{ displayNumber: numericQuery }] : []),
            { snapshotName: { contains: candidateQuery } },
            { snapshotDescription: { contains: candidateQuery } },
            { agentName: { contains: candidateQuery } },
            { worktreeBranch: { contains: candidateQuery } },
            { status: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.skill.findMany({
        where: {
          deletedAt: null,
          OR: [
            { id: { contains: candidateQuery } },
            { name: { contains: candidateQuery } },
            { description: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.skillGroup.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            { name: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.iosDevice.findMany({
        where: {
          OR: [
            { id: { contains: candidateQuery } },
            { udid: { contains: candidateQuery } },
            { displayName: { contains: candidateQuery } },
            { product: { contains: candidateQuery } },
            { osVersion: { contains: candidateQuery } },
            { status: { contains: candidateQuery } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
      prisma.signingProfileAsset.findMany({
        where: {
          missingAt: null,
          OR: [
            { id: { contains: candidateQuery } },
            { uuid: { contains: candidateQuery } },
            { name: { contains: candidateQuery } },
            { bundleId: { contains: candidateQuery } },
            { teamName: { contains: candidateQuery } },
            { profileType: { contains: candidateQuery } },
          ],
        },
        include: { agent: true },
        orderBy: { observedAt: "desc" },
        take: CANDIDATE_LIMIT,
      }),
    ]);

    const repositoryByOrigin = new Map(
      repositories.map((repository) => [
        repository.canonicalOrigin.toLocaleLowerCase(),
        repository,
      ]),
    );

    const worktreeItems = sortAndLimit(
      worktrees.map((worktree) =>
        ranked(
          {
            key: `worktree:${worktree.id}`,
            kind: "WORKTREE",
            group: "WORKTREES",
            title: worktree.branch ?? worktree.relativePath,
            subtitle: relationSubtitle([
              worktree.codebase.repository.name,
              worktree.relativePath,
              worktree.codebase.agent.name,
            ]),
            href: `/worktrees/${segment(worktree.id)}`,
            status: worktree.availability,
            updatedAt: iso(worktree.updatedAt),
          },
          query,
          worktree.branch ?? worktree.relativePath,
          [worktree.id, worktree.branch, worktree.pullRequest?.number],
          [
            worktree.folder,
            worktree.relativePath,
            worktree.codebase.repository.name,
            worktree.codebase.agent.name,
            worktree.pullRequest?.title,
          ],
        ),
      ),
      firstPerGroup,
    );

    const workflowItems = sortAndLimit(
      workflows.map((workflow) =>
        ranked(
          {
            key: `workflow:${workflow.id}`,
            kind: "WORKFLOW",
            group: "WORKFLOWS",
            title: workflow.name,
            subtitle: workflow.description || null,
            href: `/workflows/${segment(workflow.id)}`,
            status: workflow.archivedAt
              ? "ARCHIVED"
              : workflow.enabled
                ? "ENABLED"
                : "DISABLED",
            updatedAt: iso(workflow.updatedAt),
          },
          query,
          workflow.name,
          [workflow.id],
          [workflow.description],
        ),
      ),
      firstPerGroup,
    );

    if (relatedFirst > 0) {
      await this.attachWorktreeChildren(worktreeItems, relatedFirst);
      await this.attachWorkflowChildren(workflowItems, relatedFirst);
    }

    const nestedKeys = new Set(
      [...worktreeItems, ...workflowItems].flatMap((item) =>
        item.children.map((child) => child.key),
      ),
    );

    const ticketItems = sortAndLimit(
      tickets.map((ticket) => {
        const summary = jiraSummary(ticket.detailJson ?? ticket.summaryJson);
        return ranked(
          {
            key: `ticket:${ticket.issueKey}`,
            kind: "JIRA_TICKET",
            group: "TICKETS",
            title: summary.summary
              ? `${ticket.issueKey} · ${summary.summary}`
              : ticket.issueKey,
            subtitle: ticket.projectKey,
            href: `/jira/tickets/${segment(ticket.issueKey)}`,
            status: summary.status,
            updatedAt: iso(ticket.updatedAt),
          },
          query,
          summary.summary ?? ticket.issueKey,
          [ticket.issueKey],
          [ticket.projectKey, summary.status],
        );
      }),
      firstPerGroup,
    );

    const pullRequestItems = sortAndLimit(
      pullRequests.map((pullRequest) => {
        const [owner, ...repositoryParts] =
          pullRequest.repositoryNameWithOwner.split("/");
        const repository = repositoryParts.join("/");
        if (!owner || !repository) return null;
        return ranked(
          {
            key: `pull-request:${pullRequest.repositoryNameWithOwner}:${pullRequest.number}`,
            kind: "GITHUB_PULL_REQUEST",
            group: "PULL_REQUESTS",
            title: `${pullRequest.repositoryNameWithOwner} #${pullRequest.number} · ${pullRequest.title}`,
            subtitle: relationSubtitle([
              pullRequest.headRefName,
              pullRequest.jiraKey,
            ]),
            href: `/pull-requests/${segment(owner)}/${segment(repository)}/${pullRequest.number}`,
            status: pullRequest.state,
            updatedAt: iso(pullRequest.updatedAt),
          },
          query,
          pullRequest.title,
          [
            pullRequest.number,
            `#${pullRequest.number}`,
            pullRequest.githubId,
            pullRequest.jiraKey,
          ],
          [pullRequest.repositoryNameWithOwner, pullRequest.headRefName],
        );
      }),
      firstPerGroup,
    );

    const repositoryItems = sortAndLimit(
      repositories.map((repository) =>
        ranked(
          {
            key: `repository:${repository.id}`,
            kind: "REPOSITORY",
            group: "REPOSITORIES",
            title: repository.name,
            subtitle: repository.displayOrigin,
            href: `/codebases/repositories/${segment(repository.id)}`,
            status: null,
            updatedAt: iso(repository.updatedAt),
          },
          query,
          repository.name,
          [repository.id],
          [
            repository.displayOrigin,
            repository.canonicalOrigin,
            repository.description,
          ],
        ),
      ),
      firstPerGroup,
    );

    const codebaseItems = sortAndLimit(
      codebases.map((codebase) =>
        ranked(
          {
            key: `codebase:${codebase.id}`,
            kind: "CODEBASE",
            group: "CODEBASES",
            title: codebase.folder,
            subtitle: relationSubtitle([
              codebase.repository.name,
              codebase.branch,
              codebase.agent.name,
            ]),
            href: `/codebases/${segment(codebase.id)}`,
            status: codebase.availability,
            updatedAt: iso(codebase.updatedAt),
          },
          query,
          codebase.folder,
          [codebase.id, codebase.branch],
          [
            codebase.observedOrigin,
            codebase.repository.name,
            codebase.agent.name,
          ],
        ),
      ),
      firstPerGroup,
    );

    const workflowRunItems = sortAndLimit(
      workflowRuns
        .map((run) =>
          ranked(
            {
              key: `workflow-run:${run.id}`,
              kind: "WORKFLOW_RUN",
              group: "WORKFLOWS",
              title: `${run.workflow.name} #${run.displayNumber}`,
              subtitle: run.triggerSubjectKey || null,
              href: `/workflows/runs/${segment(run.id)}`,
              status: run.status,
              updatedAt: iso(run.updatedAt),
            },
            query,
            run.workflow.name,
            [run.id, run.displayNumber, `#${run.displayNumber}`],
            [run.status, run.triggerSubjectKey],
          ),
        )
        .filter((item) => !item || !nestedKeys.has(item.key)),
      firstPerGroup,
    );

    const githubActionItems = sortAndLimit(
      pipelineRecords.map((record) => {
        const repository = repositoryByOrigin.get(
          githubCanonicalOrigin(record.snapshot.repositoryNameWithOwner),
        );
        const params = new URLSearchParams();
        if (repository) params.set("repository", repository.id);
        if (record.workflowId) params.set("pipeline", record.workflowId);
        return ranked(
          {
            key: `github-actions:${record.id}`,
            kind: "GITHUB_ACTIONS_RUN",
            group: "GITHUB_ACTIONS",
            title: `${record.name}${record.runNumber ? ` #${record.runNumber}` : ""}`,
            subtitle: record.snapshot.repositoryNameWithOwner,
            href: `/actions${params.size ? `?${params.toString()}` : ""}`,
            status: record.status,
            updatedAt: iso(record.updatedAt),
          },
          query,
          record.name,
          [
            record.githubPipelineId,
            record.workflowRunId,
            record.workflowId,
            record.runNumber,
          ],
          [record.snapshot.repositoryNameWithOwner, record.status],
        );
      }),
      firstPerGroup,
    );

    const buildItems = sortAndLimit(
      builds
        .map((build) => {
          const repository =
            build.worktree?.codebase.repository ?? build.codebase?.repository;
          return ranked(
            {
              key: `build:${build.id}`,
              kind: "BUILD",
              group: "BUILDS",
              title: build.configuration?.name ?? `${build.action} build`,
              subtitle: relationSubtitle([
                repository?.name,
                build.worktree?.branch,
                build.id.slice(0, 8),
              ]),
              href: `/builds/${segment(build.id)}`,
              status: build.status,
              updatedAt: iso(build.updatedAt),
            },
            query,
            build.configuration?.name ?? `${build.action} build`,
            [build.id, build.requestId],
            [
              build.action,
              build.status,
              build.commandSummary,
              repository?.name,
              build.worktree?.branch,
              build.worktree?.folder,
            ],
          );
        })
        .filter((item) => !item || !nestedKeys.has(item.key)),
      firstPerGroup,
    );

    const agentItems = sortAndLimit(
      agents.map((agent) =>
        ranked(
          {
            key: `agent:${agent.id}`,
            kind: "AGENT",
            group: "AGENTS_JOBS",
            title: agent.name,
            subtitle: agent.hostname,
            href: `/agents/${segment(agent.id)}`,
            status: agent.disconnectedAt ? "OFFLINE" : null,
            updatedAt: iso(agent.updatedAt),
          },
          query,
          agent.name,
          [agent.id],
          [agent.hostname],
        ),
      ),
      firstPerGroup,
    );
    const jobItems = sortAndLimit(
      jobs.map((job) =>
        ranked(
          {
            key: `agent-job:${job.id}`,
            kind: "AGENT_JOB",
            group: "AGENTS_JOBS",
            title: job.kind,
            subtitle: relationSubtitle([job.agent.name, job.id.slice(0, 8)]),
            href: `/jobs/${segment(job.id)}`,
            status: job.status,
            updatedAt: iso(job.updatedAt),
          },
          query,
          job.kind,
          [job.id],
          [job.status, job.agent.name, job.agent.hostname],
        ),
      ),
      firstPerGroup,
    );

    const runItems = sortAndLimit(
      agentRuns.map((run) => {
        const kind = run.kind === "PLAN" ? "PLAN" : "SESSION";
        return ranked(
          {
            key: `${kind.toLocaleLowerCase()}:${run.id}`,
            kind,
            group: "PLANS_SESSIONS",
            title: `${kind === "PLAN" ? "Plan" : "Session"} #${run.displayNumber}`,
            subtitle: relationSubtitle([
              run.repositoryName,
              run.branch,
              run.initialPrompt.slice(0, 100),
            ]),
            href: `/${kind === "PLAN" ? "plans" : "sessions"}/${segment(run.id)}`,
            status: run.status,
            updatedAt: iso(run.updatedAt),
          },
          query,
          run.initialPrompt,
          [
            run.id,
            run.displayNumber,
            `#${run.displayNumber}`,
            run.jiraIssueKey,
          ],
          [run.repositoryName, run.branch, run.model, run.status],
        );
      }),
      firstPerGroup,
    );

    const commandItems = sortAndLimit(
      commands.map((command) =>
        ranked(
          {
            key: `command:${command.id}`,
            kind: "COMMAND",
            group: "COMMANDS_RUNS",
            title: command.name,
            subtitle: command.description || null,
            href: `/commands/${segment(command.id)}/edit`,
            status: command.archivedAt ? "ARCHIVED" : null,
            updatedAt: iso(command.updatedAt),
          },
          query,
          command.name,
          [command.id],
          [command.description, command.script],
        ),
      ),
      firstPerGroup,
    );
    const commandRunItems = sortAndLimit(
      commandRuns.map((run) =>
        ranked(
          {
            key: `command-run:${run.id}`,
            kind: "COMMAND_RUN",
            group: "COMMANDS_RUNS",
            title: `${run.snapshotName} #${run.displayNumber}`,
            subtitle: relationSubtitle([run.agentName, run.worktreeBranch]),
            href: `/commands/runs/${segment(run.id)}`,
            status: run.status,
            updatedAt: iso(run.updatedAt),
          },
          query,
          run.snapshotName,
          [run.id, run.displayNumber, `#${run.displayNumber}`],
          [
            run.snapshotDescription,
            run.agentName,
            run.worktreeBranch,
            run.status,
          ],
        ),
      ),
      firstPerGroup,
    );

    const skillItems = sortAndLimit(
      skills.map((skill) =>
        ranked(
          {
            key: `skill:${skill.id}`,
            kind: "SKILL",
            group: "SKILLS",
            title: skill.name,
            subtitle: skill.description,
            href: `/skills/${segment(skill.id)}`,
            status: null,
            updatedAt: iso(skill.updatedAt),
          },
          query,
          skill.name,
          [skill.id],
          [skill.description],
        ),
      ),
      firstPerGroup,
    );
    const skillGroupItems = sortAndLimit(
      skillGroups.map((group) =>
        ranked(
          {
            key: `skill-group:${group.id}`,
            kind: "SKILL_GROUP",
            group: "SKILLS",
            title: group.name,
            subtitle: null,
            href: `/skills/groups/${segment(group.id)}`,
            status: null,
            updatedAt: iso(group.updatedAt),
          },
          query,
          group.name,
          [group.id],
        ),
      ),
      firstPerGroup,
    );

    const deviceItems = sortAndLimit(
      devices.map((device) =>
        ranked(
          {
            key: `device:${device.id}`,
            kind: "DEVICE",
            group: "DEVICES_PROFILES",
            title: device.displayName,
            subtitle: relationSubtitle([device.product, device.osVersion]),
            href: `/devices/${segment(device.id)}`,
            status: device.status,
            updatedAt: iso(device.updatedAt),
          },
          query,
          device.displayName,
          [device.id, device.udid],
          [device.product, device.osVersion, device.status],
        ),
      ),
      firstPerGroup,
    );
    const profileItems = sortAndLimit(
      profiles.map((profile) =>
        ranked(
          {
            key: `profile:${profile.id}`,
            kind: "PROVISIONING_PROFILE",
            group: "DEVICES_PROFILES",
            title: profile.name,
            subtitle: relationSubtitle([
              profile.bundleId,
              profile.teamName,
              profile.agent.name,
            ]),
            href: `/provisioning-profiles/${segment(profile.id)}`,
            status: profile.expired ? "EXPIRED" : profile.profileType,
            updatedAt: iso(profile.observedAt),
          },
          query,
          profile.name,
          [profile.id, profile.uuid],
          [
            profile.bundleId,
            profile.teamName,
            profile.profileType,
            profile.agent.name,
          ],
        ),
      ),
      firstPerGroup,
    );

    const workflowGroupItems = sortAndLimit(
      [...workflowItems, ...workflowRunItems],
      firstPerGroup,
    );
    const agentJobGroupItems = sortAndLimit(
      [...agentItems, ...jobItems],
      firstPerGroup,
    );
    const commandRunGroupItems = sortAndLimit(
      [...commandItems, ...commandRunItems],
      firstPerGroup,
    );
    const skillGroupResultItems = sortAndLimit(
      [...skillItems, ...skillGroupItems],
      firstPerGroup,
    );
    const deviceProfileGroupItems = sortAndLimit(
      [...deviceItems, ...profileItems],
      firstPerGroup,
    );

    return {
      items: [
        ...worktreeItems,
        ...ticketItems,
        ...pullRequestItems,
        ...repositoryItems,
        ...codebaseItems,
        ...workflowGroupItems,
        ...githubActionItems,
        ...buildItems,
        ...agentJobGroupItems,
        ...runItems,
        ...commandRunGroupItems,
        ...skillGroupResultItems,
        ...deviceProfileGroupItems,
      ].map(stripScore),
    };
  }

  private async attachWorktreeChildren(
    items: RankedItem[],
    relatedFirst: number,
  ): Promise<void> {
    if (!items.length) return;
    const prisma = await getPrismaClient();
    const ids = items.map((item) => item.key.slice("worktree:".length));
    const [links, builds] = await Promise.all([
      prisma.workflowRunResourceLink.findMany({
        where: { kind: "WORKTREE", resourceId: { in: ids } },
        include: { run: { include: { workflow: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.build.findMany({
        where: { worktreeId: { in: ids } },
        include: { configuration: true },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    for (const item of items) {
      const id = item.key.slice("worktree:".length);
      const seenRuns = new Set<string>();
      const runChildren = links
        .filter((link) => link.resourceId === id && !seenRuns.has(link.runId))
        .map((link) => {
          seenRuns.add(link.runId);
          return {
            key: `workflow-run:${link.run.id}`,
            kind: "WORKFLOW_RUN" as const,
            group: "WORKFLOWS" as const,
            title: `${link.run.workflow.name} #${link.run.displayNumber}`,
            subtitle: null,
            href: `/workflows/runs/${segment(link.run.id)}`,
            status: link.run.status,
            updatedAt: iso(link.run.updatedAt),
            children: [],
          };
        })
        .slice(0, relatedFirst);
      const buildChildren = builds
        .filter((build) => build.worktreeId === id)
        .slice(0, relatedFirst)
        .map((build) => ({
          key: `build:${build.id}`,
          kind: "BUILD" as const,
          group: "BUILDS" as const,
          title: build.configuration?.name ?? `${build.action} build`,
          subtitle: build.id.slice(0, 8),
          href: `/builds/${segment(build.id)}`,
          status: build.status,
          updatedAt: iso(build.updatedAt),
          children: [],
        }));
      item.children = [...runChildren, ...buildChildren];
    }
  }

  private async attachWorkflowChildren(
    items: RankedItem[],
    relatedFirst: number,
  ): Promise<void> {
    if (!items.length) return;
    const prisma = await getPrismaClient();
    const ids = items.map((item) => item.key.slice("workflow:".length));
    const runs = await prisma.workflowRun.findMany({
      where: { workflowId: { in: ids } },
      include: { workflow: true },
      orderBy: { createdAt: "desc" },
    });
    for (const item of items) {
      const id = item.key.slice("workflow:".length);
      item.children = runs
        .filter((run) => run.workflowId === id)
        .slice(0, relatedFirst)
        .map((run) => ({
          key: `workflow-run:${run.id}`,
          kind: "WORKFLOW_RUN",
          group: "WORKFLOWS",
          title: `${run.workflow.name} #${run.displayNumber}`,
          subtitle: run.triggerSubjectKey || null,
          href: `/workflows/runs/${segment(run.id)}`,
          status: run.status,
          updatedAt: iso(run.updatedAt),
          children: [],
        }));
    }
  }
}
