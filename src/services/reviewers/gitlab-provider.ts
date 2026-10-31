import type { GitLabService } from "@/services/gitlab";
import { mapIntegrationRequests } from "@/services/integration-request";

import { applicableCodeowners, parseCodeowners } from "./codeowners";
import {
  eligibleHuman,
  errorMessage,
  mergePool,
  ownerPoolKey,
  paginated,
  providerPerson,
  statusIs,
  uniquePeople,
  type ProviderUser,
} from "./provider-utils";
import type {
  ReviewerDiscoveryOptions,
  ReviewerDiscovery,
  ReviewerPerson,
  ReviewerPoolDiscovery,
  ReviewerRepository,
  ReviewerRequestLocator,
  ReviewerRequirementDiscovery,
} from "./types";

type Share = { group_id: number; group_access_level: number };
type Project = {
  id: number;
  path_with_namespace: string;
  default_branch: string;
  namespace: { id: number; kind: string; full_path: string };
  shared_with_groups?: Share[];
};
type MergeRequest = {
  id: number;
  iid: number;
  target_project_id: number;
  web_url: string;
  state: string;
  author: ProviderUser;
  target_branch: string;
  sha: string;
  reviewers: ProviderUser[];
  changes_count?: string;
};
type ProjectRule = {
  id: number;
  name: string;
  rule_type: string;
  eligible_approvers: ProviderUser[];
  approvals_required: number;
};
type Rule = {
  id: string;
  name: string;
  type: string;
  section: string | null;
  patterns?: string[] | null;
  approvalsRequired: number;
  approved: boolean;
  sourceRule: { id: string } | null;
  eligibleApprovers: ProviderUser[] | null;
  approvedBy: {
    nodes: ProviderUser[];
    pageInfo?: { hasNextPage: boolean };
  } | null;
};

const nativeId = (id: string) => id.split("/").pop()!;

export class GitLabReviewerProvider {
  constructor(private readonly service: GitLabService) {}

  async discover(
    repository: ReviewerRepository,
    requestedRef?: string,
    locator?: ReviewerRequestLocator,
    refresh = false,
    options: ReviewerDiscoveryOptions = {},
  ): Promise<ReviewerDiscovery> {
    let directoryStale = false;
    const project = await this.service.projectForCanonicalOrigin(
      repository.canonicalOrigin,
    );
    if (!project)
      throw new Error(
        "Configure this GitLab project in integration settings before setting up reviewers",
      );
    if (locator?.projectId && locator.projectId !== String(project.id))
      throw new Error("Merge request project does not match reviewer settings");
    const prefix = `/projects/${encodeURIComponent(project.id)}`;
    const read = <T>(
      path: string,
      query: Record<string, string | number> = {},
    ) =>
      this.service.reviewerRest<T>(
        path,
        query,
        !path.includes("/merge_requests") &&
          !/\/members(?:\/all)?\/[^/]+$/.test(path)
          ? refresh
          : refresh || Boolean(locator),
        Boolean(locator),
        !path.includes("/merge_requests") &&
          !/\/members(?:\/all)?\/[^/]+$/.test(path),
        (stale) => {
          directoryStale ||= stale;
        },
      );
    const all = async <T>(
      path: string,
      query: Record<string, string | number> = {},
    ): Promise<T[]> => {
      if (options.people !== undefined) {
        if (/\/members(?:\/all)?$/.test(path)) {
          return (
            await mapIntegrationRequests(options.people, async (person) => {
              try {
                return await read<T>(
                  `${path}/${encodeURIComponent(person.id)}`,
                );
              } catch (error) {
                if (statusIs(error, 404)) return null;
                throw error;
              }
            })
          ).filter((person): person is T & {} => person !== null);
        }
        if (
          path.endsWith("/repository/branches") ||
          path.endsWith("/approval_rules")
        )
          return [];
      }
      return paginated<T>((page) =>
        read(path, { ...query, per_page: 100, page }),
      );
    };
    const [settings, metadata] = await Promise.all([
      this.service.getSettings(),
      read<Project>(prefix),
    ]);
    const identity = `GITLAB:${settings.baseUrl!.replace(/\/+$/, "").toLowerCase()}:${metadata.id}`;
    const issues: string[] = [];
    let complete = true;
    const unavailable = (label: string, error: unknown) => {
      complete = false;
      issues.push(`${label}: ${errorMessage(error)}`);
    };
    const mr = locator
      ? await read<MergeRequest>(`${prefix}/merge_requests/${locator.number}`)
      : undefined;
    if (mr && locator && String(mr.id) !== nativeId(locator.id))
      throw new Error(
        "The merge request changed. Refresh before assigning reviewers.",
      );
    if (mr && mr.target_project_id !== metadata.id)
      throw new Error(
        "Merge request target project does not match reviewer settings",
      );
    const ref = mr?.target_branch ?? requestedRef ?? metadata.default_branch;
    const [members, directMembers, refs, projectRules] = await Promise.all([
      all<ProviderUser>(`${prefix}/members/all`).catch((error) => {
        unavailable("GitLab project membership could not be loaded", error);
        return [];
      }),
      all<ProviderUser>(`${prefix}/members`).catch((error) => {
        unavailable(
          "GitLab direct project membership could not be loaded",
          error,
        );
        return [];
      }),
      all<{ name: string }>(`${prefix}/repository/branches`)
        .then((values) => values.map((value) => value.name))
        .catch(() => [metadata.default_branch]),
      all<ProjectRule>(`${prefix}/approval_rules`).catch((error) => {
        // A successful MR approvalState query below remains authoritative even
        // when project-wide setup APIs are unavailable on this tier/token.
        if (!locator) complete = false;
        issues.push(
          `GitLab project approval rules are unavailable (Premium/Ultimate and suitable permissions are required): ${errorMessage(error)}`,
        );
        return [];
      }),
    ]);
    const activeMembers = members.filter(
      (user) => eligibleHuman(user) && (user.access_level ?? 0) >= 30,
    );
    const general = uniquePeople(activeMembers.map(providerPerson));
    const memberById = new Map(general.map((person) => [person.id, person]));
    const pools = new Map<string, ReviewerPoolDiscovery>();
    const generalKey = `${identity}:general`;
    pools.set(generalKey, {
      key: generalKey,
      name: "General reviewers",
      kind: "GENERAL",
      candidates: general,
    });
    for (const pool of (options.pools ?? []).filter(
      (pool) => pool.kind === "APPROVAL_RULE",
    ))
      mergePool(pools, {
        ...pool,
        candidates: pool.candidates.filter((person) =>
          memberById.has(person.id),
        ),
      });
    for (const rule of projectRules) {
      const candidates =
        rule.rule_type === "any_approver"
          ? general
          : (rule.eligible_approvers ?? [])
              .filter(eligibleHuman)
              .map(providerPerson);
      mergePool(pools, {
        key: `${identity}:rule:${rule.id}`,
        name: rule.name,
        kind: "APPROVAL_RULE",
        candidates,
      });
    }

    let contents: string | undefined;
    for (const path of options.summary
      ? []
      : ["CODEOWNERS", "docs/CODEOWNERS", ".gitlab/CODEOWNERS"]) {
      try {
        const file = await read<{ content: string; encoding: string }>(
          `${prefix}/repository/files/${encodeURIComponent(path)}`,
          { ref },
        );
        if (file.encoding !== "base64" || typeof file.content !== "string")
          throw new Error("GitLab CODEOWNERS contents were not returned");
        contents = Buffer.from(file.content, "base64").toString("utf8");
        break;
      } catch (error) {
        if (statusIs(error, 404)) continue;
        unavailable("GitLab CODEOWNERS could not be loaded", error);
        break;
      }
    }
    const entries =
      contents === undefined ? [] : parseCodeowners(contents, "GITLAB");
    const entryPool = new Map<string, string>();
    let allowedGroups: Promise<Set<number>> | undefined;
    const validGroups = () => {
      allowedGroups ??= (async () => {
        const ids = new Set(
          (metadata.shared_with_groups ?? [])
            .filter((share) => share.group_access_level >= 30)
            .map((share) => share.group_id),
        );
        let groupId =
          metadata.namespace.kind === "group" ? metadata.namespace.id : null;
        const seen = new Set<number>();
        while (groupId !== null && !seen.has(groupId)) {
          seen.add(groupId);
          ids.add(groupId);
          const group: {
            parent_id: number | null;
            shared_with_groups?: Share[];
          } = await read(`/groups/${groupId}`, { with_projects: "false" });
          for (const share of group.shared_with_groups ?? [])
            if (share.group_access_level >= 30) ids.add(share.group_id);
          groupId = group.parent_id;
        }
        return ids;
      })();
      return allowedGroups;
    };
    const resolutions = new Map<
      string,
      Promise<{ principal: string; label: string; people: ReviewerPerson[] }>
    >();
    const resolve = (token: string) => {
      let pending = resolutions.get(token.toLowerCase());
      if (!pending) {
        pending = (async () => {
          if (token.startsWith("@@")) {
            const role = token.slice(2).toLowerCase().replace(/s$/, "");
            const access = { developer: 30, maintainer: 40, owner: 50 }[role];
            if (!access)
              throw new Error(`Unsupported GitLab CODEOWNERS role: ${token}`);
            return {
              principal: `role:${access}`,
              label: `@@${role}`,
              people: directMembers
                .filter(
                  (user) => eligibleHuman(user) && user.access_level === access,
                )
                .map(providerPerson),
            };
          }
          const username = token.startsWith("@") ? token.slice(1) : null;
          const individual = activeMembers.find((user) =>
            username
              ? user.username?.toLowerCase() === username.toLowerCase()
              : (user.email ?? user.public_email)?.toLowerCase() ===
                token.toLowerCase(),
          );
          if (individual)
            return {
              principal: `user:${individual.id}`,
              label: `@${individual.username}`,
              people: [providerPerson(individual)],
            };
          if (!username)
            throw new Error(
              `Email owner ${token} is not visible to the configured token; use a visible username or group`,
            );
          // A GitLab @mention may identify either a user or a nested group.
          const users = username.includes("/")
            ? []
            : await read<ProviderUser[]>("/users", { username });
          const user = users.find(
            (candidate) =>
              candidate.username?.toLowerCase() === username.toLowerCase(),
          );
          if (user)
            return {
              principal: `user:${user.id}`,
              label: `@${user.username}`,
              people: memberById.has(String(user.id))
                ? [providerPerson(user)]
                : [],
            };
          const group = await read<{ id: number; full_path: string }>(
            `/groups/${encodeURIComponent(username)}`,
            { with_projects: "false" },
          );
          const allowed = await validGroups();
          if (!allowed.has(group.id))
            return {
              principal: `group:${group.id}`,
              label: `@${group.full_path}`,
              people: [],
            };
          const groupMembers = await all<ProviderUser>(
            `/groups/${group.id}/members`,
          );
          return {
            principal: `group:${group.id}`,
            label: `@${group.full_path}`,
            people: groupMembers
              .filter(eligibleHuman)
              .map(providerPerson)
              .filter((person) => memberById.has(person.id)),
          };
        })();
        resolutions.set(token.toLowerCase(), pending);
      }
      return pending;
    };
    const resolvedEntries = await mapIntegrationRequests(
      entries.filter((entry) => !entry.exclusion && entry.owners.length),
      async (entry) => {
        try {
          const resolved = await mapIntegrationRequests(entry.owners, resolve);
          return { entry, resolved };
        } catch (error) {
          return { entry, error };
        }
      },
    );
    // Concurrent lookups must not change which duplicate pattern wins.
    for (const result of resolvedEntries) {
      if (!result.resolved) {
        unavailable(
          `GitLab owners for ${result.entry.pattern} could not be resolved`,
          result.error,
        );
        continue;
      }
      const key = ownerPoolKey(
        identity,
        result.resolved.map((value) => value.principal),
      );
      mergePool(pools, {
        key,
        name: result.resolved.map((value) => value.label).join(" or "),
        kind: "CODEOWNERS",
        candidates: result.resolved.flatMap((value) => value.people),
      });
      entryPool.set(`${result.entry.section}\0${result.entry.pattern}`, key);
    }

    const requirements: ReviewerRequirementDiscovery[] = [];
    const approvedReviewers: ReviewerPerson[] = [];
    const [major, minor] = (settings.version ?? "19.2").split(".").map(Number);
    const groupedPatterns = major > 19 || (major === 19 && minor >= 4);
    const approvalRules = async (iid: number): Promise<Rule[]> => {
      const data = await this.service.reviewerGraphql<{
        project: {
          mergeRequest: { approvalState: { rules: Rule[] | null } } | null;
        } | null;
      }>(
        `query CodeReviewerApprovalRules($path: ID!, $iid: String!) {
            project(fullPath: $path) { mergeRequest(iid: $iid) { approvalState { rules {
              id name type section ${groupedPatterns ? "patterns" : ""} approvalsRequired approved
              sourceRule { id }
              approvedBy(first: 100) { nodes { id username name avatarUrl webUrl } pageInfo { hasNextPage } }
            } } } }
          }`,
        { path: metadata.path_with_namespace, iid: String(iid) },
      );
      const rules = data.project?.mergeRequest?.approvalState.rules;
      if (!rules)
        throw new Error(
          "GitLab did not return the merge request approval rules",
        );
      if (options.people === undefined || options.validateEligibility) {
        type Eligibility = {
          project: {
            mergeRequest: {
              approvalState: {
                rules: Array<{ id: string; eligibleApprovers: ProviderUser[] }>;
              };
            };
          };
        };
        const query = `query CodeReviewerEligibility($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) { approvalState { rules { id eligibleApprovers { id username name avatarUrl webUrl bot state } } } } } }`;
        const variables = {
          path: metadata.path_with_namespace,
          iid: String(iid),
        };
        // Saves revalidate the rule's actual eligibility, independently of daily directory snapshots.
        const eligibility = options.validateEligibility
          ? await this.service.reviewerGraphql<Eligibility>(query, variables)
          : await this.service.reviewerEligibility<Eligibility>(
              query,
              variables,
              refresh,
              (stale) => {
                directoryStale ||= stale;
              },
              ref,
            );
        const eligible = new Map(
          eligibility.project?.mergeRequest?.approvalState.rules.map((rule) => [
            rule.id,
            rule.eligibleApprovers,
          ]),
        );
        for (const rule of rules)
          rule.eligibleApprovers = eligible.get(rule.id) ?? [];
      }
      return rules;
    };
    const approvalPoolKey = (rule: Rule, requestId: number) => {
      const source = rule.sourceRule?.id ?? rule.id;
      return rule.sourceRule || source.includes("ApprovalProjectRule/")
        ? `${identity}:rule:${nativeId(source)}`
        : `${identity}:mr:${requestId}:rule:${nativeId(rule.id)}`;
    };
    if (mr) {
      const representedEntries = new Set<string>();
      try {
        const rules = await approvalRules(mr.iid);
        for (const rule of rules) {
          const type = rule.type.toLowerCase();
          let eligible =
            type === "any_approver"
              ? general
              : (rule.eligibleApprovers ?? [])
                  .filter(eligibleHuman)
                  .map(providerPerson);
          const approved = (rule.approvedBy?.nodes ?? []).map(providerPerson);
          approvedReviewers.push(...approved);
          if (rule.approvedBy?.pageInfo?.hasNextPage)
            unavailable(
              `Approvals for ${rule.name} are incomplete`,
              new Error("GitLab returned more than 100 approving users"),
            );
          let keys: string[];
          let count = rule.approvalsRequired;
          let label = rule.name;
          const patterns =
            type === "code_owner"
              ? rule.patterns?.length
                ? rule.patterns
                : [rule.name]
              : [];
          if (type === "code_owner") {
            keys = [
              ...new Set(
                patterns.flatMap((pattern) => {
                  const entryIdentity = `${(rule.section ?? "codeowners").toLowerCase()}\0${pattern}`;
                  representedEntries.add(entryIdentity);
                  const key = entryPool.get(entryIdentity);
                  return key ? [key] : [];
                }),
              ),
            ];
            if (keys.length === 0 && !options.summary)
              unavailable(
                `Code owner rule ${rule.name} cannot be mapped`,
                new Error("Refresh the target branch CODEOWNERS configuration"),
              );
            if (count === 0) {
              count = 1;
              label = `Suggested code owners · ${rule.name}`;
            }
          } else {
            const key = approvalPoolKey(rule, mr.id);
            mergePool(pools, {
              key,
              name: rule.name,
              kind: "APPROVAL_RULE",
              candidates: eligible,
            });
            keys = [key];
          }
          if (options.people !== undefined && !options.validateEligibility)
            eligible = uniquePeople([
              ...keys.flatMap((key) => pools.get(key)?.candidates ?? []),
              ...approved,
            ]);
          // Keep the provider's grouped requirement intact: preferences from
          // contributing owner pools filter choices without creating quotas.
          requirements.push({
            id: rule.id,
            name: label,
            isRequired: rule.approvalsRequired > 0,
            patterns,
            poolKeys: keys,
            eligibleReviewerIds: eligible.map((person) => person.id),
            requiredApprovals: count,
            approvedReviewerIds: approved.map((person) => person.id),
          });
        }
      } catch (error) {
        unavailable(
          "GitLab merge request approval rules could not be loaded",
          error,
        );
      }
      try {
        // The aggregate endpoint also contains valid approvals outside a named
        // rule, which can satisfy a general-reviewer fallback.
        const approvals = await read<{
          approved_by?: Array<{ user: ProviderUser }>;
        }>(`${prefix}/merge_requests/${mr.iid}/approvals`);
        approvedReviewers.push(
          ...(approvals.approved_by ?? []).map((approval) =>
            providerPerson(approval.user),
          ),
        );
      } catch (error) {
        unavailable("GitLab current approvals could not be loaded", error);
      }
      if (entries.length) {
        try {
          const files = await all<{ new_path: string; old_path: string }>(
            `${prefix}/merge_requests/${mr.iid}/diffs`,
          );
          if (
            mr.changes_count &&
            /^\d+$/.test(mr.changes_count) &&
            Number(mr.changes_count) > files.length
          )
            unavailable(
              "GitLab changed files are incomplete",
              new Error(
                "The merge request exceeds the provider diff-list limit",
              ),
            );
          const paths = [
            ...new Set(
              files
                .flatMap((file) => [file.new_path, file.old_path])
                .filter(Boolean),
            ),
          ];
          for (const entry of applicableCodeowners(entries, paths)) {
            const entryIdentity = `${entry.section}\0${entry.pattern}`;
            if (representedEntries.has(entryIdentity)) continue;
            const key = entryPool.get(entryIdentity);
            const pool = key ? pools.get(key) : null;
            if (!key || !pool?.candidates.length) continue;
            requirements.push({
              id: `gitlab:suggested:${entryIdentity}`,
              name: `Suggested code owners · ${entry.pattern}`,
              isRequired: false,
              patterns: [entry.pattern],
              poolKeys: [key],
              eligibleReviewerIds: pool.candidates.map((person) => person.id),
              requiredApprovals: 1,
              approvedReviewerIds: approvedReviewers.map((person) => person.id),
            });
          }
        } catch (error) {
          unavailable(
            "GitLab changed files for ownership suggestions could not be loaded",
            error,
          );
        }
      }
    } else {
      // Custom MR rules have no project source. Include their native identities
      // in repository setup so users can configure them without label matching.
      try {
        const requests = await all<MergeRequest>(`${prefix}/merge_requests`, {
          state: "opened",
          scope: "all",
        });
        await mapIntegrationRequests(requests, async (request) => {
          try {
            for (const rule of await approvalRules(request.iid)) {
              if (rule.type.toLowerCase() === "code_owner") continue;
              const key = approvalPoolKey(rule, request.id);
              if (!key.includes(`:mr:${request.id}:`)) continue;
              const candidates =
                rule.type.toLowerCase() === "any_approver"
                  ? general
                  : (rule.eligibleApprovers ?? [])
                      .filter(eligibleHuman)
                      .map(providerPerson);
              mergePool(pools, {
                key,
                name: `!${request.iid} · ${rule.name}`,
                kind: "APPROVAL_RULE",
                candidates,
              });
            }
          } catch (error) {
            unavailable(
              `GitLab approval groups for !${request.iid} could not be loaded`,
              error,
            );
          }
        });
      } catch (error) {
        unavailable(
          "GitLab open merge request approval groups could not be loaded",
          error,
        );
      }
    }
    return {
      membersLoaded: options.people === undefined,
      directoryStale,
      provider: "GITLAB",
      repositoryIdentity: identity,
      ref,
      defaultRef: metadata.default_branch,
      refs: [...new Set([metadata.default_branch, ref, ...refs])],
      pools: [...pools.values()],
      requirements,
      issues: [...new Set(issues)],
      discoveryComplete: complete,
      ...(mr
        ? {
            request: {
              id: locator!.id,
              number: mr.iid,
              url: mr.web_url,
              open: mr.state === "opened",
              authorId: String(mr.author.id),
              baseRef: mr.target_branch,
              headSha: mr.sha,
              currentReviewers: uniquePeople(
                (mr.reviewers ?? []).map(providerPerson),
              ),
              approvedReviewers: uniquePeople(approvedReviewers),
            },
          }
        : {}),
    };
  }

  async resolvePeople(ids: string[]) {
    return mapIntegrationRequests(ids, async (id) => {
      const user = await this.service.reviewerRest<ProviderUser>(
        `/users/${encodeURIComponent(id)}`,
        {},
        true,
        true,
      );
      if (!eligibleHuman(user) || providerPerson(user).id !== id)
        throw new Error("Reviewer identity is no longer available");
      return providerPerson(user);
    });
  }

  async assign(
    repository: ReviewerRepository,
    request: ReviewerRequestLocator,
    people: ReviewerPerson[],
    removePeople: ReviewerPerson[] = [],
  ): Promise<void> {
    const project = await this.service.projectForCanonicalOrigin(
      repository.canonicalOrigin,
    );
    if (!project || (request.projectId && request.projectId !== project.id))
      throw new Error("Merge request project does not match reviewer settings");
    await this.service.addMergeRequestReviewers({
      projectId: project.id,
      iid: request.number,
      expectedId: nativeId(request.id),
      reviewerIds: people.map((person) => person.id),
      removeReviewerIds: removePeople.map((person) => person.id),
    });
  }
}
