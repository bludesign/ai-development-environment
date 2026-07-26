"use client";

import { useEffect, useMemo, useState } from "react";

import type { SearchableSelectOption } from "@/components/common/searchable-select";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { ResourceKind } from "@/lib/workflows/config-descriptor-types";

/** Resources whose list query needs a scoping argument to return anything. */
const REQUIRES_SCOPE: Partial<Record<ResourceKind, true>> = {
  iosConfiguration: true,
  jiraUser: true,
  agentRun: true,
  githubWorkflowRun: true,
};

export type ResourceOptionsState = {
  options: SearchableSelectOption[];
  loading: boolean;
  /** True when the control should degrade to a free-text input. */
  fallback: boolean;
};

type ResourcePlan = {
  query: string;
  variables: Record<string, unknown>;
  map: (data: Record<string, unknown>) => SearchableSelectOption[];
};

function pick<T>(value: unknown): T {
  return value as T;
}

/**
 * Builds the list query for one resource kind. Exported for the test that
 * guards the page-size arguments: the GitHub list resolvers reject a `first`
 * above their page size rather than clamping it, and the hook swallows the
 * error into a free-text fallback, so an over-large page size silently removes
 * the picker instead of failing loudly.
 */
export function resourcePlan(
  resource: ResourceKind,
  scope: string | null,
): ResourcePlan | null {
  switch (resource) {
    case "agent":
      return {
        query: `query WorkflowAgentOptions {
          agents { id name hostname connectionStatus }
        }`,
        variables: {},
        map: (data) =>
          pick<{
            agents?: {
              id: string;
              name: string;
              hostname: string;
              connectionStatus: string;
            }[];
          }>(data).agents?.map((agent) => ({
            value: agent.id,
            label: agent.name,
            description: `${agent.hostname} · ${agent.connectionStatus}`,
          })) ?? [],
      };
    case "codebase":
      return {
        query: `query WorkflowCodebaseOptions {
          codebaseOverview { repositories { name codebases { id folder } } }
        }`,
        variables: {},
        map: (data) =>
          pick<{
            codebaseOverview?: {
              repositories: {
                name: string;
                codebases: { id: string; folder: string }[];
              }[];
            };
          }>(data).codebaseOverview?.repositories.flatMap((repository) =>
            repository.codebases.map((codebase) => ({
              value: codebase.id,
              label: codebase.folder || repository.name,
              description: repository.name,
            })),
          ) ?? [],
      };
    case "worktree":
      return {
        query: `query WorkflowWorktreeOptions {
          worktreeOverview {
            agents { codebases { codebase { folder } worktrees { id branch folder } } }
          }
          hiddenWorktrees { id branch folder }
        }`,
        variables: {},
        map: (data) => {
          const typed = pick<{
            worktreeOverview?: {
              agents: {
                codebases: {
                  codebase: { folder: string };
                  worktrees: {
                    id: string;
                    branch: string | null;
                    folder: string;
                  }[];
                }[];
              }[];
            };
            hiddenWorktrees?: {
              id: string;
              branch: string | null;
              folder: string;
            }[];
          }>(data);
          const visible =
            typed.worktreeOverview?.agents.flatMap((agent) =>
              agent.codebases.flatMap((group) =>
                group.worktrees.map((worktree) => ({
                  value: worktree.id,
                  label: worktree.branch || worktree.folder,
                  description: group.codebase.folder,
                })),
              ),
            ) ?? [];
          const hidden =
            typed.hiddenWorktrees?.map((worktree) => ({
              value: worktree.id,
              label: worktree.branch || worktree.folder,
            })) ?? [];
          return [...visible, ...hidden];
        },
      };
    case "githubRepository":
      return {
        query: `query WorkflowRepositoryOptions {
          githubRepositories { githubId nameWithOwner }
        }`,
        variables: {},
        map: (data) =>
          pick<{
            githubRepositories?: { githubId: string; nameWithOwner: string }[];
          }>(data).githubRepositories?.map((repository) => ({
            value: repository.githubId,
            label: repository.nameWithOwner,
          })) ?? [],
      };
    case "githubPullRequest":
      return {
        query: `query WorkflowPullRequestOptions($scope: GitHubPullRequestScope!, $repositoryId: ID) {
          githubPullRequests(source: WORKFLOW_AUTOMATION, scope: $scope, repositoryId: $repositoryId, first: 25) {
            items { number title }
          }
        }`,
        variables: scope
          ? { scope: "REPOSITORY", repositoryId: scope }
          : { scope: "MINE", repositoryId: null },
        map: (data) =>
          pick<{
            githubPullRequests?: { items: { number: number; title: string }[] };
          }>(data).githubPullRequests?.items.map((pullRequest) => ({
            value: String(pullRequest.number),
            label: `#${pullRequest.number} ${pullRequest.title}`,
          })) ?? [],
      };
    case "jiraTicket":
      return {
        query: `query WorkflowTicketOptions {
          jiraCachedTickets(limit: 100) { key summary }
        }`,
        variables: {},
        map: (data) =>
          pick<{
            jiraCachedTickets?: { key: string; summary: string }[];
          }>(data).jiraCachedTickets?.map((ticket) => ({
            value: ticket.key,
            label: ticket.key,
            description: ticket.summary,
          })) ?? [],
      };
    case "jiraUser":
      if (!scope) return null;
      return {
        query: `query WorkflowAssignableUsers($issueKey: String!) {
          jiraAssignableUsers(issueKey: $issueKey) { accountId displayName }
        }`,
        variables: { issueKey: scope },
        map: (data) =>
          pick<{
            jiraAssignableUsers?: {
              accountId: string | null;
              displayName: string;
            }[];
          }>(data).jiraAssignableUsers?.flatMap((user) =>
            user.accountId
              ? [{ value: user.accountId, label: user.displayName }]
              : [],
          ) ?? [],
      };
    case "apnsChannel":
      return {
        query: `query WorkflowChannelOptions {
          apnsBroadcastChannels { channelId bundleId }
        }`,
        variables: {},
        map: (data) =>
          pick<{
            apnsBroadcastChannels?: { channelId: string; bundleId: string }[];
          }>(data).apnsBroadcastChannels?.map((channel) => ({
            value: channel.channelId,
            label: channel.channelId,
            description: channel.bundleId,
          })) ?? [],
      };
    case "apnsRegistration":
      return {
        query: `query WorkflowRegistrationOptions {
          apnsRegistrations { id displayName topic }
        }`,
        variables: {},
        map: (data) =>
          pick<{
            apnsRegistrations?: {
              id: string;
              displayName: string;
              topic: string;
            }[];
          }>(data).apnsRegistrations?.map((registration) => ({
            value: registration.id,
            label: registration.displayName,
            description: registration.topic,
          })) ?? [],
      };
    case "skillGroup":
      return {
        query: `query WorkflowSkillGroupOptions {
          skillsOverview { groups { id name } }
        }`,
        variables: {},
        map: (data) =>
          pick<{
            skillsOverview?: { groups: { id: string; name: string }[] };
          }>(data).skillsOverview?.groups.map((group) => ({
            value: group.id,
            label: group.name,
          })) ?? [],
      };
    case "mcpServer":
      return {
        query: `query WorkflowMcpServerOptions {
          externalMcpServers { id name }
        }`,
        variables: {},
        map: (data) =>
          pick<{ externalMcpServers?: { id: string; name: string }[] }>(
            data,
          ).externalMcpServers?.map((server) => ({
            value: server.id,
            label: server.name,
          })) ?? [],
      };
    case "iosConfiguration":
      if (!scope) return null;
      return {
        query: `query WorkflowConfigurationOptions($codebaseId: ID!) {
          iosAppProject(codebaseId: $codebaseId) { configurations { id name } }
        }`,
        variables: { codebaseId: scope },
        map: (data) =>
          pick<{
            iosAppProject?: { configurations: { id: string; name: string }[] };
          }>(data).iosAppProject?.configurations.map((configuration) => ({
            value: configuration.id,
            label: configuration.name,
          })) ?? [],
      };
    case "buildScript":
      return {
        query: `query WorkflowBuildScriptOptions {
          buildScripts { id name }
        }`,
        variables: {},
        map: (data) =>
          pick<{ buildScripts?: { id: string; name: string }[] }>(
            data,
          ).buildScripts?.map((script) => ({
            value: script.id,
            label: script.name,
          })) ?? [],
      };
    case "agentRun":
      if (!scope) return null;
      return {
        query: `query WorkflowAgentRunOptions($kind: RunKind!) {
          agentRuns(kind: $kind, first: 50) { items { id displayNumber initialPrompt } }
        }`,
        variables: { kind: scope },
        map: (data) =>
          pick<{
            agentRuns?: {
              items: {
                id: string;
                displayNumber: number;
                initialPrompt: string;
              }[];
            };
          }>(data).agentRuns?.items.map((run) => ({
            value: run.id,
            label: `#${run.displayNumber}`,
            description: run.initialPrompt,
          })) ?? [],
      };
    case "githubWorkflowRun":
      if (!scope) return null;
      return {
        query: `query WorkflowActionsRunOptions($codebaseRepositoryId: ID) {
          githubActionsWorkflowRuns(source: WORKFLOW_AUTOMATION, codebaseRepositoryId: $codebaseRepositoryId, first: 25) {
            items { id displayTitle headBranch }
          }
        }`,
        variables: { codebaseRepositoryId: scope },
        map: (data) =>
          pick<{
            githubActionsWorkflowRuns?: {
              items: {
                id: string;
                displayTitle: string | null;
                headBranch: string | null;
              }[];
            };
          }>(data).githubActionsWorkflowRuns?.items.map((run) => ({
            value: run.id,
            label: run.displayTitle || run.id,
            description: run.headBranch ?? undefined,
          })) ?? [],
      };
    default:
      return null;
  }
}

/**
 * Fetches selectable options for a data-driven resource field. Mirrors the
 * fetch/render pattern in export-settings-form and ticket-worktree-dialog.
 * Falls back to a free-text input when a required scope is missing, when the
 * query errors, or when it returns no rows.
 */
export function useResourceOptions(
  resource: ResourceKind,
  scope: string | null,
): ResourceOptionsState {
  const plan = useMemo(
    () =>
      REQUIRES_SCOPE[resource] && !scope ? null : resourcePlan(resource, scope),
    [resource, scope],
  );
  const planKey = plan
    ? JSON.stringify({ query: plan.query, variables: plan.variables })
    : null;

  const [result, setResult] = useState<{
    key: string;
    options: SearchableSelectOption[];
    error: boolean;
  }>({ key: "", options: [], error: false });

  useEffect(() => {
    if (!plan || !planKey) return;
    let cancelled = false;
    void controlPlaneRequest<Record<string, unknown>>(
      plan.query,
      plan.variables,
    )
      .then((data) => {
        if (!cancelled) {
          setResult({ key: planKey, options: plan.map(data), error: false });
        }
      })
      .catch(() => {
        if (!cancelled) setResult({ key: planKey, options: [], error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [plan, planKey]);

  if (!plan || !planKey) {
    return { options: [], loading: false, fallback: true };
  }
  if (result.key !== planKey) {
    return { options: [], loading: true, fallback: false };
  }
  return {
    options: result.options,
    loading: false,
    fallback: result.error || result.options.length === 0,
  };
}
