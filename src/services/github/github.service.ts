import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";

import type {
  GitHubPipelineStatus,
  GitHubPullRequestPage,
  GitHubPullRequestScope,
  GitHubPullRequestView,
  GitHubRepositoryCandidatePage,
  GitHubRepositoryView,
  GitHubReviewDecision,
  GitHubSettingsView,
  GitHubViewer,
} from "./types";

const SETTINGS_ID = "default";
const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const SEARCH_RESULT_LIMIT = 1000;
export const DEFAULT_JIRA_KEY_REGEX = String.raw`\b([A-Z][A-Z0-9_]*-\d+)\b`;

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type RawConnection<T> = {
  nodes: Array<T | null> | null;
  pageInfo: PageInfo;
};

type RawPullRequest = {
  id: string;
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  repository: {
    id: string;
    nameWithOwner: string;
    url: string;
  };
  labels: RawConnection<{ name: string }>;
  statusCheckRollup: { state: string } | null;
  reviewDecision: string | null;
  reviewThreads: RawConnection<{ isResolved: boolean }>;
};

type GitHubResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

const PULL_REQUEST_FRAGMENT = `
  fragment PullRequestTableFields on PullRequest {
    id
    number
    title
    url
    createdAt
    updatedAt
    repository { id nameWithOwner url }
    labels(first: 100) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
    statusCheckRollup { state }
    reviewDecision
    reviewThreads(first: 100) {
      nodes { isResolved }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function repositoryView(repository: {
  id: string;
  githubId: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
  jiraKeyRegex: string | null;
}): GitHubRepositoryView {
  return {
    id: repository.id,
    githubId: repository.githubId,
    owner: repository.owner,
    name: repository.name,
    nameWithOwner: repository.nameWithOwner,
    url: repository.url,
    jiraKeyRegex: repository.jiraKeyRegex,
  };
}

function connectionNodes<T>(connection: RawConnection<T>): T[] {
  return (connection.nodes ?? []).filter((node): node is T => node !== null);
}

function sanitizeError(message: string, token: string): string {
  return message.split(token).join("[REDACTED]");
}

export function normalizeGitHubRepositoryName(value: string): {
  owner: string;
  name: string;
} {
  const parts = value.trim().split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(parts[1])
  ) {
    throw new Error("Repository must use the owner/name format");
  }
  return { owner: parts[0], name: parts[1] };
}

export function normalizeJiraKeyRegex(
  value: string | null | undefined,
): string | null {
  const pattern = value?.trim() ?? "";
  if (!pattern) return null;
  try {
    void new RegExp(pattern, "i");
  } catch {
    throw new Error("Jira key regex is invalid");
  }
  return pattern;
}

export function parseJiraKey(
  title: string,
  pattern: string | null,
): string | null {
  if (!pattern) return null;
  const match = new RegExp(pattern, "i").exec(title);
  const value = (match?.[1] ?? match?.[0])?.trim();
  return value ? value.toUpperCase() : null;
}

function pipelineStatus(
  value: string | null | undefined,
): GitHubPipelineStatus {
  if (
    value === "ERROR" ||
    value === "EXPECTED" ||
    value === "FAILURE" ||
    value === "PENDING" ||
    value === "SUCCESS"
  ) {
    return value;
  }
  return "NONE";
}

function reviewDecision(value: string | null): GitHubReviewDecision {
  if (
    value === "APPROVED" ||
    value === "CHANGES_REQUESTED" ||
    value === "REVIEW_REQUIRED"
  ) {
    return value;
  }
  return "NONE";
}

export class GitHubService {
  private async request<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "ai-development-environment",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new Error(
        sanitizeError(
          error instanceof Error ? error.message : String(error),
          token,
        ),
      );
    }

    let body: GitHubResponse<T>;
    try {
      body = (await response.json()) as GitHubResponse<T>;
    } catch {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }

    if (!response.ok || body.errors?.length || !body.data) {
      const message =
        body.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `GitHub returned HTTP ${response.status}`;
      throw new Error(sanitizeError(message, token));
    }
    return body.data;
  }

  private async requireToken(): Promise<string> {
    const prisma = await getPrismaClient();
    const settings = await prisma.gitHubSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (!settings?.apiToken) {
      throw new Error("GitHub credentials are not configured");
    }
    return settings.apiToken;
  }

  async getSettings(): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    const settings = await prisma.gitHubSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
    return {
      tokenConfigured: Boolean(settings.apiToken),
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async saveSettings(input: {
    apiToken?: string | null;
  }): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    const nextToken = input.apiToken?.trim() || existing?.apiToken || null;
    if (!nextToken)
      throw new Error("A GitHub personal access token is required");
    await prisma.gitHubSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, apiToken: nextToken },
      update: { apiToken: nextToken },
    });
    return this.getSettings();
  }

  async clearCredentials(): Promise<GitHubSettingsView> {
    const prisma = await getPrismaClient();
    await prisma.gitHubSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: { apiToken: null },
    });
    return this.getSettings();
  }

  private async viewer(token: string): Promise<GitHubViewer> {
    const data = await this.request<{ viewer: GitHubViewer }>(
      `query GitHubViewer { viewer { login name avatarUrl url } }`,
      {},
      token,
    );
    return data.viewer;
  }

  async testConnection(): Promise<GitHubViewer> {
    return this.viewer(await this.requireToken());
  }

  async listRepositories(): Promise<GitHubRepositoryView[]> {
    const prisma = await getPrismaClient();
    const repositories = await prisma.gitHubRepository.findMany({
      orderBy: { nameWithOwner: "asc" },
    });
    return repositories.map(repositoryView);
  }

  async availableRepositories(
    after?: string | null,
  ): Promise<GitHubRepositoryCandidatePage> {
    const token = await this.requireToken();
    const data = await this.request<{
      viewer: {
        repositories: RawConnection<{
          id: string;
          nameWithOwner: string;
          url: string;
          isPrivate: boolean;
        }>;
      };
    }>(
      `query GitHubAvailableRepositories($after: String) {
        viewer {
          repositories(
            first: 50
            after: $after
            affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
            ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
            isArchived: false
            orderBy: { field: PUSHED_AT, direction: DESC }
          ) {
            nodes { id nameWithOwner url isPrivate }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { after: after || null },
      token,
    );
    const prisma = await getPrismaClient();
    const managed = new Set(
      (
        await prisma.gitHubRepository.findMany({ select: { githubId: true } })
      ).map((repository) => repository.githubId),
    );
    const connection = data.viewer.repositories;
    return {
      items: connectionNodes(connection).map((repository) => ({
        githubId: repository.id,
        nameWithOwner: repository.nameWithOwner,
        url: repository.url,
        isPrivate: repository.isPrivate,
        managed: managed.has(repository.id),
      })),
      hasNextPage: connection.pageInfo.hasNextPage,
      endCursor: connection.pageInfo.endCursor,
    };
  }

  async addRepository(input: {
    nameWithOwner: string;
    jiraKeyRegex?: string | null;
  }): Promise<GitHubRepositoryView[]> {
    const { owner, name } = normalizeGitHubRepositoryName(input.nameWithOwner);
    const jiraKeyRegex = normalizeJiraKeyRegex(
      input.jiraKeyRegex === undefined
        ? DEFAULT_JIRA_KEY_REGEX
        : input.jiraKeyRegex,
    );
    const token = await this.requireToken();
    const data = await this.request<{
      repository: {
        id: string;
        name: string;
        nameWithOwner: string;
        url: string;
        owner: { login: string };
      } | null;
    }>(
      `query GitHubRepository($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          id name nameWithOwner url owner { login }
        }
      }`,
      { owner, name },
      token,
    );
    if (!data.repository) {
      throw new Error("Repository was not found or is not accessible");
    }
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubRepository.findFirst({
      where: {
        OR: [
          { githubId: data.repository.id },
          { nameWithOwner: data.repository.nameWithOwner },
        ],
      },
    });
    if (existing) throw new Error("Repository is already managed");
    await prisma.gitHubRepository.create({
      data: {
        id: randomUUID(),
        githubId: data.repository.id,
        owner: data.repository.owner.login,
        name: data.repository.name,
        nameWithOwner: data.repository.nameWithOwner,
        url: data.repository.url,
        jiraKeyRegex,
      },
    });
    return this.listRepositories();
  }

  async updateRepository(input: {
    id: string;
    jiraKeyRegex?: string | null;
  }): Promise<GitHubRepositoryView[]> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubRepository.findUnique({
      where: { id: input.id },
    });
    if (!existing) throw new Error("Managed repository was not found");
    await prisma.gitHubRepository.update({
      where: { id: input.id },
      data: { jiraKeyRegex: normalizeJiraKeyRegex(input.jiraKeyRegex) },
    });
    return this.listRepositories();
  }

  async removeRepository(id: string): Promise<GitHubRepositoryView[]> {
    const prisma = await getPrismaClient();
    const result = await prisma.gitHubRepository.deleteMany({ where: { id } });
    if (result.count === 0) throw new Error("Managed repository was not found");
    return this.listRepositories();
  }

  private async searchPullRequests(
    query: string,
    token: string,
  ): Promise<{ items: RawPullRequest[]; truncated: boolean }> {
    const items: RawPullRequest[] = [];
    let after: string | null = null;
    let truncated = false;
    while (true) {
      const data: {
        search: RawConnection<RawPullRequest>;
      } = await this.request(
        `query GitHubPullRequestSearch($query: String!, $after: String) {
          search(query: $query, type: ISSUE, first: 50, after: $after) {
            nodes { ...PullRequestTableFields }
            pageInfo { hasNextPage endCursor }
          }
        }
        ${PULL_REQUEST_FRAGMENT}`,
        { query, after },
        token,
      );
      items.push(...connectionNodes(data.search));
      if (items.length >= SEARCH_RESULT_LIMIT) {
        truncated = data.search.pageInfo.hasNextPage;
        break;
      }
      if (!data.search.pageInfo.hasNextPage) break;
      after = data.search.pageInfo.endCursor;
    }
    return { items: items.slice(0, SEARCH_RESULT_LIMIT), truncated };
  }

  private async repositoryPullRequests(
    repository: GitHubRepositoryView,
    token: string,
  ): Promise<RawPullRequest[]> {
    const items: RawPullRequest[] = [];
    let after: string | null = null;
    while (true) {
      const data: {
        repository: {
          pullRequests: RawConnection<RawPullRequest>;
        } | null;
      } = await this.request(
        `query GitHubRepositoryPullRequests(
          $owner: String!
          $name: String!
          $after: String
        ) {
          repository(owner: $owner, name: $name) {
            pullRequests(
              states: OPEN
              first: 50
              after: $after
              orderBy: { field: UPDATED_AT, direction: DESC }
            ) {
              nodes { ...PullRequestTableFields }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
        ${PULL_REQUEST_FRAGMENT}`,
        { owner: repository.owner, name: repository.name, after },
        token,
      );
      if (!data.repository) {
        throw new Error(
          "Managed repository was not found or is not accessible",
        );
      }
      items.push(...connectionNodes(data.repository.pullRequests));
      if (!data.repository.pullRequests.pageInfo.hasNextPage) break;
      after = data.repository.pullRequests.pageInfo.endCursor;
    }
    return items;
  }

  private async remainingLabels(
    pullRequestId: string,
    after: string,
    token: string,
  ): Promise<string[]> {
    const labels: string[] = [];
    let cursor: string | null = after;
    while (cursor) {
      const data: {
        node: { labels: RawConnection<{ name: string }> } | null;
      } = await this.request(
        `query GitHubPullRequestLabels($id: ID!, $after: String) {
          node(id: $id) {
            ... on PullRequest {
              labels(first: 100, after: $after) {
                nodes { name }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: pullRequestId, after: cursor },
        token,
      );
      if (!data.node) break;
      labels.push(
        ...connectionNodes(data.node.labels).map((label) => label.name),
      );
      cursor = data.node.labels.pageInfo.hasNextPage
        ? data.node.labels.pageInfo.endCursor
        : null;
    }
    return labels;
  }

  private async remainingUnresolvedThreads(
    pullRequestId: string,
    after: string,
    token: string,
  ): Promise<number> {
    let count = 0;
    let cursor: string | null = after;
    while (cursor) {
      const data: {
        node: {
          reviewThreads: RawConnection<{ isResolved: boolean }>;
        } | null;
      } = await this.request(
        `query GitHubPullRequestReviewThreads($id: ID!, $after: String) {
          node(id: $id) {
            ... on PullRequest {
              reviewThreads(first: 100, after: $after) {
                nodes { isResolved }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { id: pullRequestId, after: cursor },
        token,
      );
      if (!data.node) break;
      count += connectionNodes(data.node.reviewThreads).filter(
        (thread) => !thread.isResolved,
      ).length;
      cursor = data.node.reviewThreads.pageInfo.hasNextPage
        ? data.node.reviewThreads.pageInfo.endCursor
        : null;
    }
    return count;
  }

  private async normalizePullRequest(
    pullRequest: RawPullRequest,
    jiraKeyRegex: string | null,
    token: string,
  ): Promise<GitHubPullRequestView> {
    const labels = connectionNodes(pullRequest.labels).map(
      (label) => label.name,
    );
    if (
      pullRequest.labels.pageInfo.hasNextPage &&
      pullRequest.labels.pageInfo.endCursor
    ) {
      labels.push(
        ...(await this.remainingLabels(
          pullRequest.id,
          pullRequest.labels.pageInfo.endCursor,
          token,
        )),
      );
    }
    let unresolvedReviewThreadCount = connectionNodes(
      pullRequest.reviewThreads,
    ).filter((thread) => !thread.isResolved).length;
    if (
      pullRequest.reviewThreads.pageInfo.hasNextPage &&
      pullRequest.reviewThreads.pageInfo.endCursor
    ) {
      unresolvedReviewThreadCount += await this.remainingUnresolvedThreads(
        pullRequest.id,
        pullRequest.reviewThreads.pageInfo.endCursor,
        token,
      );
    }
    return {
      id: pullRequest.id,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      repositoryGithubId: pullRequest.repository.id,
      repositoryNameWithOwner: pullRequest.repository.nameWithOwner,
      repositoryUrl: pullRequest.repository.url,
      labels,
      jiraKey: parseJiraKey(pullRequest.title, jiraKeyRegex),
      pipelineStatus: pipelineStatus(pullRequest.statusCheckRollup?.state),
      reviewDecision: reviewDecision(pullRequest.reviewDecision),
      unresolvedReviewThreadCount,
      createdAt: pullRequest.createdAt,
    };
  }

  async pullRequests(
    scope: GitHubPullRequestScope,
    repositoryId?: string | null,
  ): Promise<GitHubPullRequestPage> {
    const token = await this.requireToken();
    const prisma = await getPrismaClient();
    const repositories = await prisma.gitHubRepository.findMany();
    const regexByGitHubId = new Map(
      repositories.map((repository) => [
        repository.githubId,
        repository.jiraKeyRegex,
      ]),
    );
    let rawItems: RawPullRequest[];
    let truncated = false;

    if (scope === "REPOSITORY") {
      if (!repositoryId) {
        throw new Error(
          "repositoryId is required for repository pull requests",
        );
      }
      const repository = repositories.find((item) => item.id === repositoryId);
      if (!repository) throw new Error("Managed repository was not found");
      rawItems = await this.repositoryPullRequests(
        repositoryView(repository),
        token,
      );
    } else {
      if (repositoryId) {
        throw new Error(
          "repositoryId is only valid for repository pull requests",
        );
      }
      const viewer = await this.viewer(token);
      if (scope === "REVIEW_REQUESTED") {
        const result = await this.searchPullRequests(
          `is:pr is:open review-requested:${viewer.login} sort:updated-desc`,
          token,
        );
        rawItems = result.items;
        truncated = result.truncated;
      } else if (scope === "MINE") {
        const [authored, assigned] = await Promise.all([
          this.searchPullRequests(
            `is:pr is:open author:${viewer.login} sort:updated-desc`,
            token,
          ),
          this.searchPullRequests(
            `is:pr is:open assignee:${viewer.login} sort:updated-desc`,
            token,
          ),
        ]);
        const unique = new Map<string, RawPullRequest>();
        for (const pullRequest of [...authored.items, ...assigned.items]) {
          unique.set(pullRequest.id, pullRequest);
        }
        rawItems = [...unique.values()].sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        );
        truncated = authored.truncated || assigned.truncated;
      } else {
        throw new Error("Unknown GitHub pull request scope");
      }
    }

    return {
      items: await Promise.all(
        rawItems.map((pullRequest) =>
          this.normalizePullRequest(
            pullRequest,
            regexByGitHubId.get(pullRequest.repository.id) ?? null,
            token,
          ),
        ),
      ),
      truncated,
    };
  }
}
