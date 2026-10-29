import type { GitHubService } from "@/services/github";
import { mapIntegrationRequests } from "@/services/integration-request";

import {
  applicableCodeowners,
  parseCodeowners,
  reviewerRuleApplies,
} from "./codeowners";
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
  ReviewerDiscovery,
  ReviewerPerson,
  ReviewerPoolDiscovery,
  ReviewerRepository,
  ReviewerRequestLocator,
  ReviewerRequirementDiscovery,
} from "./types";

type Repository = {
  id: number;
  default_branch: string;
  permissions?: { push?: boolean };
};
type PullRequest = {
  id: number;
  node_id: string;
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  user: ProviderUser;
  base: { ref: string; repo: { id: number } };
  head: { sha: string };
  changed_files: number;
};
type Review = {
  id: number;
  user: ProviderUser;
  state: string;
  submitted_at: string | null;
};
type Team = { id: number; slug: string; name: string };
type BranchProtection = {
  id: string;
  requiresApprovingReviews: boolean;
  requiredApprovingReviewCount: number;
  requiresCodeOwnerReviews: boolean;
  requireLastPushApproval?: boolean;
};
type BranchRule = {
  type: string;
  ruleset_id: number;
  ruleset_source_type: string;
  parameters?: {
    required_approving_review_count?: number;
    require_code_owner_review?: boolean;
    require_last_push_approval?: boolean;
    required_reviewers?: Array<{
      file_patterns: string[];
      minimum_approvals: number;
      reviewer: { id: number; type: string };
    }>;
  };
};

export class GitHubReviewerProvider {
  constructor(private readonly service: GitHubService) {}

  private parts(repository: ReviewerRepository) {
    const match = /^github\.com\/([^/]+)\/([^/]+)$/i.exec(
      repository.canonicalOrigin,
    );
    if (!match)
      throw new Error(
        "GitHub reviewer settings require a github.com repository",
      );
    return {
      owner: match[1],
      name: match[2],
      prefix: `/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
    };
  }

  async discover(
    repository: ReviewerRepository,
    requestedRef?: string,
    locator?: ReviewerRequestLocator,
    refresh = false,
  ): Promise<ReviewerDiscovery> {
    const { owner, name, prefix } = this.parts(repository);
    const read = <T>(path: string) =>
      this.service.reviewerRest<T>(path, Boolean(locator), refresh);
    const all = <T>(path: string) =>
      paginated<T>((page) =>
        read(
          `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        ),
      );
    const metadata = await read<Repository>(prefix);
    const identity = `GITHUB:github.com:${metadata.id}`;
    const issues: string[] = [];
    let complete = true;
    const unavailable = (label: string, error: unknown) => {
      complete = false;
      issues.push(`${label}: ${errorMessage(error)}`);
    };
    const pr = locator
      ? await read<PullRequest>(`${prefix}/pulls/${locator.number}`)
      : undefined;
    if (pr && locator && ![String(pr.id), pr.node_id].includes(locator.id)) {
      throw new Error(
        "The pull request changed. Refresh the worktree before assigning reviewers.",
      );
    }
    if (pr && pr.base.repo.id !== metadata.id)
      throw new Error(
        "Pull request target repository does not match reviewer settings",
      );
    const ref = pr?.base.ref ?? requestedRef ?? metadata.default_branch;
    const rawCollaborators = await all<ProviderUser>(
      `${prefix}/collaborators`,
    ).catch((error) => {
      unavailable(
        "GitHub repository members could not be loaded; check repo and read:org permissions",
        error,
      );
      return [];
    });
    const collaborators = rawCollaborators.filter(
      (user) =>
        eligibleHuman(user) &&
        (user.permissions?.push ||
          user.permissions?.maintain ||
          user.permissions?.admin),
    );
    const general = uniquePeople(collaborators.map(providerPerson));
    const generalById = new Map(general.map((person) => [person.id, person]));
    const pools = new Map<string, ReviewerPoolDiscovery>();
    const generalKey = `${identity}:general`;
    pools.set(generalKey, {
      key: generalKey,
      name: "General reviewers",
      kind: "GENERAL",
      candidates: general,
    });
    const refs = await all<{ name: string }>(`${prefix}/branches`)
      .then((branches) => branches.map((branch) => branch.name))
      .catch(() => [metadata.default_branch]);

    const [branchRules, protection] = await Promise.all([
      all<BranchRule>(
        `${prefix}/rules/branches/${encodeURIComponent(ref)}`,
      ).catch((error) => {
        unavailable("GitHub rulesets could not be loaded", error);
        return [];
      }),
      this.service
        .reviewerGraphql<{
          repository: {
            ref: { branchProtectionRule: BranchProtection | null } | null;
          } | null;
        }>(
          `query CodeReviewerBranchProtection($owner: String!, $name: String!, $ref: String!) {
          repository(owner: $owner, name: $name) {
            ref(qualifiedName: $ref) { branchProtectionRule {
              id requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews requireLastPushApproval
            } }
          }
        }`,
          { owner, name, ref: `refs/heads/${ref}` },
          Boolean(locator),
          refresh,
        )
        .then((result) => result.repository?.ref?.branchProtectionRule ?? null)
        .catch((error) => {
          unavailable("GitHub branch protection could not be loaded", error);
          return null;
        }),
    ]);

    let paths: string[] = [];
    let currentReviewers: ReviewerPerson[] = [];
    let approvedReviewers: ReviewerPerson[] = [];
    if (pr) {
      const [files, requested, reviews] = await Promise.all([
        all<{ filename: string; previous_filename?: string }>(
          `${prefix}/pulls/${pr.number}/files`,
        ),
        read<{ users: ProviderUser[] }>(
          `${prefix}/pulls/${pr.number}/requested_reviewers`,
        ),
        all<Review>(`${prefix}/pulls/${pr.number}/reviews`),
      ]);
      paths = [
        ...new Set(
          files.flatMap((file) => [
            file.filename,
            ...(file.previous_filename ? [file.previous_filename] : []),
          ]),
        ),
      ];
      if (files.length < pr.changed_files)
        unavailable(
          "GitHub changed files are incomplete",
          new Error("The pull request exceeds the provider file-list limit"),
        );
      currentReviewers = uniquePeople(
        (requested.users ?? []).map(providerPerson),
      );
      const latest = new Map<string, Review>();
      for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
        if (
          ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
        )
          latest.set(String(review.user.id), review);
      }
      approvedReviewers = uniquePeople(
        [...latest.values()]
          .filter((review) => review.state === "APPROVED")
          .map((review) => providerPerson(review.user)),
      );
    }
    const approvedIds = approvedReviewers.map((person) => person.id);
    const requirements: ReviewerRequirementDiscovery[] = [];
    const pullRules = branchRules.filter(
      (rule) => rule.type === "pull_request",
    );
    const requiredCount = Math.max(
      protection?.requiresApprovingReviews
        ? protection.requiredApprovingReviewCount
        : 0,
      0,
      ...pullRules.map(
        (rule) => rule.parameters?.required_approving_review_count ?? 0,
      ),
    );
    const requiresCodeowners = Boolean(
      protection?.requiresCodeOwnerReviews ||
      pullRules.some((rule) => rule.parameters?.require_code_owner_review),
    );
    if (
      pr &&
      (protection?.requireLastPushApproval ||
        pullRules.some((rule) => rule.parameters?.require_last_push_approval))
    ) {
      unavailable(
        "Latest-push approval cannot be fully verified",
        new Error(
          "GitHub requires approval after the latest push from someone other than its pusher. Check this requirement in GitHub before merging.",
        ),
      );
    }
    if (pr && requiredCount > 0)
      requirements.push({
        id: "github:required-approvals",
        name: "Required approvals",
        poolKeys: [generalKey],
        eligibleReviewerIds: general.map((person) => person.id),
        requiredApprovals: requiredCount,
        approvedReviewerIds: approvedIds,
      });

    const teamCache = new Map<
      string,
      Promise<{ principal: string; label: string; people: ReviewerPerson[] }>
    >();
    const team = (
      organization: string,
      slug: string,
      requireRepositoryAccess: boolean,
    ) => {
      const cacheKey = `${organization.toLowerCase()}/${slug.toLowerCase()}/${requireRepositoryAccess}`;
      let pending = teamCache.get(cacheKey);
      if (!pending) {
        pending = (async () => {
          const path = `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(slug)}`;
          const value = await read<Team>(path);
          if (requireRepositoryAccess) {
            const access = await read<{
              permissions?: { push?: boolean };
              permission?: string;
            }>(
              `${path}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
            );
            if (
              !access.permissions?.push &&
              !["push", "write", "maintain", "admin"].includes(
                access.permission ?? "",
              )
            ) {
              return {
                principal: `team:${value.id}`,
                label: `@${organization}/${slug}`,
                people: [],
              };
            }
          }
          const members = await all<ProviderUser>(`${path}/members`);
          return {
            principal: `team:${value.id}`,
            label: `@${organization}/${slug}`,
            people: members
              .filter(eligibleHuman)
              .map(providerPerson)
              .filter((person) => generalById.has(person.id)),
          };
        })();
        teamCache.set(cacheKey, pending);
      }
      return pending;
    };
    let visibleTeams: Promise<Team[]> | undefined;
    for (const rule of pullRules) {
      for (const requirement of rule.parameters?.required_reviewers ?? []) {
        try {
          if (requirement.reviewer.type !== "Team")
            throw new Error("Unsupported required-reviewer type");
          visibleTeams ??= all<Team>(
            `/orgs/${encodeURIComponent(owner)}/teams`,
          );
          const native = (await visibleTeams).find(
            (candidate) => candidate.id === requirement.reviewer.id,
          );
          if (!native)
            throw new Error(
              `Team ${requirement.reviewer.id} is not visible to the configured token`,
            );
          const resolved = await team(owner, native.slug, false);
          const key = `${identity}:ruleset:${rule.ruleset_source_type}:${rule.ruleset_id}:team:${native.id}`;
          mergePool(pools, {
            key,
            name: `Rule ${rule.ruleset_id} · ${native.name}`,
            kind: "APPROVAL_RULE",
            candidates: resolved.people,
          });
          if (pr && reviewerRuleApplies(requirement.file_patterns, paths))
            requirements.push({
              id: `${key}:${requirements.length}`,
              name: `${native.name}${requirement.minimum_approvals ? " approval rule" : " (optional review)"}`,
              poolKeys: [key],
              eligibleReviewerIds: resolved.people.map((person) => person.id),
              requiredApprovals: requirement.minimum_approvals,
              approvedReviewerIds: approvedIds,
            });
        } catch (error) {
          unavailable(
            "GitHub required-reviewer team could not be loaded",
            error,
          );
        }
      }
    }

    let contents: string | undefined;
    for (const path of [
      ".github/CODEOWNERS",
      "CODEOWNERS",
      "docs/CODEOWNERS",
    ]) {
      try {
        const file = await read<{
          content?: string;
          encoding?: string;
          size: number;
        }>(`${prefix}/contents/${path}?ref=${encodeURIComponent(ref)}`);
        if (file.size >= 3 * 1024 * 1024)
          throw new Error("GitHub ignores CODEOWNERS files of 3 MB or larger");
        if (file.encoding !== "base64" || typeof file.content !== "string")
          throw new Error("GitHub CODEOWNERS contents were not returned");
        contents = Buffer.from(file.content, "base64").toString("utf8");
        break;
      } catch (error) {
        if (statusIs(error, 404)) continue;
        unavailable("GitHub CODEOWNERS could not be loaded", error);
        break;
      }
    }
    if (contents !== undefined) {
      const entries = parseCodeowners(contents, "GITHUB");
      const applicable = new Set(
        pr ? applicableCodeowners(entries, paths) : [],
      );
      const resolutions = new Map<
        string,
        Promise<{ principal: string; label: string; people: ReviewerPerson[] }>
      >();
      const resolve = (token: string) => {
        let pending = resolutions.get(token.toLowerCase());
        if (!pending) {
          pending = (async () => {
            if (token.startsWith("@") && token.includes("/")) {
              const [organization, slug] = token.slice(1).split("/");
              return team(organization, slug, true);
            }
            if (token.startsWith("@")) {
              const user = await read<ProviderUser>(
                `/users/${encodeURIComponent(token.slice(1))}`,
              );
              const person = generalById.get(String(user.id));
              return {
                principal: `user:${user.id}`,
                label: `@${user.login}`,
                people: person ? [person] : [],
              };
            }
            const user = collaborators.find(
              (candidate) =>
                (candidate.email ?? candidate.public_email)?.toLowerCase() ===
                token.toLowerCase(),
            );
            if (!user)
              throw new Error(
                `Email owner ${token} cannot be resolved with the configured token; use a visible username or team`,
              );
            return {
              principal: `user:${user.id}`,
              label: `@${user.login}`,
              people: [providerPerson(user)],
            };
          })();
          resolutions.set(token.toLowerCase(), pending);
        }
        return pending;
      };
      await mapIntegrationRequests(
        entries.filter((entry) => entry.owners.length > 0),
        async (entry) => {
          try {
            const resolved = await mapIntegrationRequests(
              entry.owners,
              resolve,
            );
            const key = ownerPoolKey(
              identity,
              resolved.map((value) => value.principal),
            );
            const candidates = uniquePeople(
              resolved.flatMap((value) => value.people),
            );
            const label = resolved.map((value) => value.label).join(" or ");
            mergePool(pools, {
              key,
              name: label,
              kind: "CODEOWNERS",
              candidates,
            });
            if (pr && applicable.has(entry))
              requirements.push({
                id: `github:codeowners:${entry.pattern}`,
                name: `${requiresCodeowners ? "Code owners" : "Suggested code owners"} · ${entry.pattern}`,
                poolKeys: [key],
                eligibleReviewerIds: candidates.map((person) => person.id),
                requiredApprovals: 1,
                approvedReviewerIds: approvedIds,
              });
          } catch (error) {
            unavailable(
              `GitHub owners for ${entry.pattern} could not be resolved`,
              error,
            );
          }
        },
      );
    }
    return {
      provider: "GITHUB",
      repositoryIdentity: identity,
      ref,
      defaultRef: metadata.default_branch,
      refs: [...new Set([metadata.default_branch, ref, ...refs])],
      pools: [...pools.values()],
      requirements,
      issues: [...new Set(issues)],
      discoveryComplete: complete,
      ...(pr
        ? {
            request: {
              id: locator!.id,
              number: pr.number,
              url: pr.html_url,
              open: pr.state === "open" && !pr.merged,
              authorId: String(pr.user.id),
              baseRef: pr.base.ref,
              headSha: pr.head.sha,
              currentReviewers,
              approvedReviewers,
            },
          }
        : {}),
    };
  }

  async assign(
    repository: ReviewerRepository,
    locator: ReviewerRequestLocator,
    people: ReviewerPerson[],
  ): Promise<void> {
    const { owner, name } = this.parts(repository);
    await this.service.addPullRequestReviewers({
      owner,
      name,
      number: locator.number,
      expectedId: locator.id,
      reviewers: people.map(({ id, username }) => ({ id, username })),
    });
  }
}
