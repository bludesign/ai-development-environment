import { describe, expect, test, vi } from "vitest";

import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";

import { GitHubReviewerProvider } from "./github-provider";
import { GitLabReviewerProvider } from "./gitlab-provider";
import { ownerPoolKey } from "./provider-utils";

const user = (id: number, username: string, extra = {}) => ({
  id,
  login: username,
  username,
  name: username,
  permissions: { push: true },
  state: "active",
  access_level: 30,
  ...extra,
});
const alice = user(1, "alice");
const bob = user(2, "bob");
const carol = user(3, "carol");
const author = user(4, "author");
const encoded = (value: string) => ({
  content: Buffer.from(value).toString("base64"),
  encoding: "base64",
  size: value.length,
});
const missing = () =>
  Object.assign(new Error("Not found"), { statusCode: 404 });

function githubFixture() {
  const pr = {
    id: 77,
    node_id: "PR_77",
    number: 8,
    html_url: "https://github.com/acme/project/pull/8",
    state: "open",
    merged: false,
    user: author,
    base: { ref: "main", repo: { id: 10 } },
    head: { sha: "head" },
    changed_files: 2,
  };
  const reviewerRest = vi.fn(async (url: string) => {
    const path = url.split("?")[0];
    const values: Record<string, unknown> = {
      "/repos/acme/project": { id: 10, default_branch: "main" },
      "/repos/acme/project/collaborators": [
        alice,
        bob,
        carol,
        author,
        user(20, "robot", { type: "Bot" }),
        user(21, "reader", { permissions: { push: false } }),
      ],
      "/repos/acme/project/branches": [{ name: "main" }, { name: "release" }],
      "/repos/acme/project/rules/branches/main": [
        {
          type: "pull_request",
          ruleset_id: 20,
          ruleset_source_type: "Organization",
          parameters: {
            required_approving_review_count: 2,
            require_code_owner_review: true,
            required_reviewers: [
              {
                reviewer: { type: "Team", id: 100 },
                minimum_approvals: 2,
                file_patterns: ["src/**", "!src/generated/**"],
              },
            ],
          },
        },
      ],
      "/repos/acme/project/pulls/8": pr,
      "/repos/acme/project/pulls/8/files": [
        { filename: "src/main.swift" },
        { filename: "docs/readme.md" },
      ],
      "/repos/acme/project/pulls/8/requested_reviewers": { users: [bob] },
      "/repos/acme/project/pulls/8/reviews": [
        { id: 1, user: alice, state: "APPROVED" },
        { id: 2, user: alice, state: "COMMENTED" },
        { id: 3, user: carol, state: "APPROVED" },
        { id: 4, user: carol, state: "DISMISSED" },
      ],
      "/repos/acme/project/contents/.github/CODEOWNERS": encoded(
        "src/ @acme/backend\nother/ @acme/backend\n/docs/ @alice @carol",
      ),
      "/orgs/acme/teams": [{ id: 100, slug: "backend", name: "Backend" }],
      "/orgs/acme/teams/backend": { id: 100, slug: "backend", name: "Backend" },
      "/orgs/acme/teams/backend/repos/acme/project": {
        permissions: { push: true },
      },
      "/orgs/acme/teams/backend/members": [alice, bob, carol],
      "/users/alice": alice,
      "/users/carol": carol,
    };
    if (!(path in values)) throw missing();
    return values[path];
  });
  const reviewerGraphql = vi.fn(async () => ({
    repository: {
      ref: {
        branchProtectionRule: {
          id: "BP_1",
          requiresApprovingReviews: true,
          requiredApprovingReviewCount: 1,
          requiresCodeOwnerReviews: true,
        },
      },
    },
  }));
  const addPullRequestReviewers = vi.fn().mockResolvedValue(undefined);
  const service = {
    reviewerRest,
    reviewerGraphql,
    addPullRequestReviewers,
  } as unknown as GitHubService;
  return {
    provider: new GitHubReviewerProvider(service),
    reviewerRest,
    reviewerGraphql,
    addPullRequestReviewers,
    pr,
  };
}

describe("GitHub reviewer adapter", () => {
  test("forwards explicit refresh to all repository discovery reads", async () => {
    const { provider, reviewerRest, reviewerGraphql } = githubFixture();
    await provider.discover(
      { id: "repo", canonicalOrigin: "github.com/acme/project" },
      undefined,
      undefined,
      true,
    );
    expect(reviewerRest).toHaveBeenCalledWith(
      "/repos/acme/project",
      false,
      true,
    );
    expect(reviewerGraphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      false,
      true,
    );
  });

  test("shares owner pools, combines active rule counts, and preserves valid approvals", async () => {
    const { provider } = githubFixture();
    const snapshot = await provider.discover(
      { id: "repo", canonicalOrigin: "github.com/acme/project" },
      undefined,
      { id: "PR_77", number: 8 },
    );
    expect(snapshot.repositoryIdentity).toBe("GITHUB:github.com:10");
    expect(snapshot.discoveryComplete).toBe(true);
    expect(
      snapshot.pools.filter((pool) => pool.kind === "CODEOWNERS"),
    ).toHaveLength(2);
    expect(
      snapshot.pools
        .find((pool) => pool.kind === "GENERAL")
        ?.candidates.map((person) => person.username),
    ).toEqual(["alice", "author", "bob", "carol"]);
    expect(
      snapshot.requirements.find(
        (rule) => rule.id === "github:required-approvals",
      )?.requiredApprovals,
    ).toBe(2);
    expect(
      snapshot.requirements.find(
        (rule) => rule.name === "Backend approval rule",
      )?.requiredApprovals,
    ).toBe(2);
    expect(
      snapshot.request?.approvedReviewers.map((person) => person.id),
    ).toEqual(["1"]);
    expect(
      snapshot.request?.currentReviewers.map((person) => person.id),
    ).toEqual(["2"]);
    expect(
      snapshot.requirements.some((rule) => rule.name.includes("other/")),
    ).toBe(false);
  });

  test("explicitly adds review requests without replacing existing people or teams", async () => {
    const { provider, addPullRequestReviewers } = githubFixture();
    await provider.assign(
      { id: "repo", canonicalOrigin: "github.com/acme/project" },
      { id: "PR_77", number: 8 },
      [
        {
          id: "3",
          username: "carol",
          name: "Carol",
          avatarUrl: null,
          url: null,
        },
      ],
    );
    expect(addPullRequestReviewers).toHaveBeenCalledWith({
      owner: "acme",
      name: "project",
      number: 8,
      expectedId: "PR_77",
      reviewers: [{ id: "3", username: "carol" }],
    });
  });

  test("rejects stale requests and flags truncated changed-file lists", async () => {
    const { provider, pr } = githubFixture();
    await expect(
      provider.discover(
        { id: "repo", canonicalOrigin: "github.com/acme/project" },
        undefined,
        { id: "PR_old", number: 8 },
      ),
    ).rejects.toThrow("changed");
    pr.changed_files = 5;
    const snapshot = await provider.discover(
      { id: "repo", canonicalOrigin: "github.com/acme/project" },
      undefined,
      { id: "PR_77", number: 8 },
    );
    expect(snapshot.discoveryComplete).toBe(false);
    expect(snapshot.issues.join(" ")).toContain("file-list limit");
  });

  test("keeps latest-push policy uncertainty visible", async () => {
    const { provider, reviewerGraphql } = githubFixture();
    reviewerGraphql.mockResolvedValue({
      repository: {
        ref: {
          branchProtectionRule: {
            id: "BP_1",
            requiresApprovingReviews: true,
            requiredApprovingReviewCount: 1,
            requiresCodeOwnerReviews: true,
            requireLastPushApproval: true,
          },
        },
      },
    } as never);
    const snapshot = await provider.discover(
      { id: "repo", canonicalOrigin: "github.com/acme/project" },
      undefined,
      { id: "PR_77", number: 8 },
    );
    expect(snapshot.discoveryComplete).toBe(false);
    expect(snapshot.issues.join(" ")).toContain("latest push");
  });
});

function gitlabFixture() {
  const rule = {
    id: "gid://gitlab/ApprovalMergeRequestRule/201",
    name: "codeowners",
    type: "CODE_OWNER",
    section: "codeowners",
    patterns: ["src/", "tests/"],
    approvalsRequired: 2,
    approved: false,
    sourceRule: null,
    eligibleApprovers: [alice, bob],
    approvedBy: { nodes: [alice], pageInfo: { hasNextPage: false } },
  };
  const reviewerRest = vi.fn(async (path: string) => {
    const values: Record<string, unknown> = {
      "/projects/10": {
        id: 10,
        path_with_namespace: "org/project",
        default_branch: "main",
        namespace: { id: 100, kind: "group", full_path: "org" },
        shared_with_groups: [{ group_id: 101, group_access_level: 30 }],
      },
      "/projects/10/members/all": [
        alice,
        bob,
        carol,
        author,
        user(5, "inherited"),
      ],
      "/projects/10/members": [
        alice,
        { ...carol, access_level: 40 },
        user(6, "owner", { access_level: 50 }),
      ],
      "/projects/10/repository/branches": [{ name: "main" }],
      "/projects/10/approval_rules": [
        {
          id: 7,
          name: "Security",
          rule_type: "regular",
          eligible_approvers: [bob, carol],
          approvals_required: 2,
        },
      ],
      "/projects/10/repository/files/CODEOWNERS": encoded(
        "src/ @org/backend\ntests/ @org/backend\n[Docs][2]\nREADME.md @@maintainers",
      ),
      "/groups/org%2Fbackend": { id: 101, full_path: "org/backend" },
      "/groups/100": { parent_id: null, shared_with_groups: [] },
      "/groups/101/members": [alice, bob],
      "/projects/10/merge_requests/8": {
        id: 77,
        iid: 8,
        target_project_id: 10,
        web_url: "https://gitlab.example/org/project/-/merge_requests/8",
        state: "opened",
        author,
        target_branch: "main",
        sha: "head",
        reviewers: [bob],
      },
      "/projects/10/merge_requests/8/approvals": {
        approved_by: [{ user: alice }],
      },
      "/projects/10/merge_requests/8/diffs": [
        { new_path: "src/main.swift", old_path: "src/main.swift" },
      ],
      "/projects/10/merge_requests": [],
    };
    if (!(path in values)) throw missing();
    return values[path];
  });
  const reviewerGraphql = vi.fn().mockResolvedValue({
    project: {
      mergeRequest: {
        approvalState: {
          rules: [
            rule,
            {
              id: "gid://gitlab/ApprovalProjectRule/7",
              name: "Security",
              type: "REGULAR",
              section: null,
              approvalsRequired: 2,
              approved: false,
              sourceRule: null,
              eligibleApprovers: [bob, carol],
              approvedBy: { nodes: [] },
            },
          ],
        },
      },
    },
  });
  const addMergeRequestReviewers = vi.fn().mockResolvedValue(undefined);
  const service = {
    projectForCanonicalOrigin: vi.fn().mockResolvedValue({ id: "10" }),
    getSettings: vi.fn().mockResolvedValue({
      baseUrl: "https://gitlab.example",
      version: "19.4.0",
    }),
    reviewerRest,
    reviewerGraphql,
    addMergeRequestReviewers,
  } as unknown as GitLabService;
  return {
    provider: new GitLabReviewerProvider(service),
    reviewerRest,
    reviewerGraphql,
    addMergeRequestReviewers,
    rule,
  };
}

describe("GitLab reviewer adapter", () => {
  test("discovers shared ownership before an MR and honors direct group/role membership", async () => {
    const { provider } = gitlabFixture();
    const snapshot = await provider.discover({
      id: "repo",
      canonicalOrigin: "gitlab.example/org/project",
    });
    expect(snapshot.discoveryComplete).toBe(true);
    expect(
      snapshot.pools.filter((pool) => pool.kind === "CODEOWNERS"),
    ).toHaveLength(2);
    expect(
      snapshot.pools
        .find((pool) => pool.name === "@org/backend")
        ?.candidates.map((person) => person.id),
    ).toEqual(["1", "2"]);
    expect(
      snapshot.pools
        .find((pool) => pool.name === "@@maintainer")
        ?.candidates.map((person) => person.id),
    ).toEqual(["3"]);
  });

  test("keeps a grouped native codeowner requirement once and maps project rules by identity", async () => {
    const { provider, reviewerGraphql } = gitlabFixture();
    const snapshot = await provider.discover(
      { id: "repo", canonicalOrigin: "gitlab.example/org/project" },
      undefined,
      { id: "77", number: 8, projectId: "10" },
    );
    expect(snapshot.discoveryComplete).toBe(true);
    expect(snapshot.requirements).toHaveLength(2);
    expect(snapshot.requirements[0]).toMatchObject({
      requiredApprovals: 2,
      approvedReviewerIds: ["1"],
    });
    expect(snapshot.requirements[0].poolKeys).toEqual([
      ownerPoolKey(snapshot.repositoryIdentity, ["group:101"]),
    ]);
    expect(snapshot.requirements[1].poolKeys).toEqual([
      `${snapshot.repositoryIdentity}:rule:7`,
    ]);
    expect(reviewerGraphql.mock.calls[0][0]).toContain("patterns");
  });

  test("flags unmatched CODEOWNERS rules without matching by a display label", async () => {
    const { provider, rule } = gitlabFixture();
    rule.patterns = ["unknown/"];
    const snapshot = await provider.discover(
      { id: "repo", canonicalOrigin: "gitlab.example/org/project" },
      undefined,
      { id: "77", number: 8, projectId: "10" },
    );
    expect(snapshot.discoveryComplete).toBe(false);
    expect(snapshot.requirements[0].poolKeys).toEqual([]);
  });

  test("includes native MR-only groups in repository setup", async () => {
    const { provider, reviewerRest, reviewerGraphql } = gitlabFixture();
    const read = reviewerRest.getMockImplementation()!;
    reviewerRest.mockImplementation(async (path) =>
      path === "/projects/10/merge_requests"
        ? [{ id: 77, iid: 8 }]
        : read(path),
    );
    reviewerGraphql.mockResolvedValue({
      project: {
        mergeRequest: {
          approvalState: {
            rules: [
              {
                id: "gid://gitlab/ApprovalMergeRequestRule/99",
                name: "Custom approvers",
                type: "REGULAR",
                approvalsRequired: 2,
                sourceRule: null,
                eligibleApprovers: [bob, carol],
              },
            ],
          },
        },
      },
    });
    const snapshot = await provider.discover({
      id: "repo",
      canonicalOrigin: "gitlab.example/org/project",
    });
    expect(
      snapshot.pools.find((pool) => pool.key.endsWith(":mr:77:rule:99")),
    ).toMatchObject({
      name: "!8 · Custom approvers",
      candidates: [{ id: "2" }, { id: "3" }],
    });
  });

  test("offers relevant ownership suggestions when native enforcement emits no rules", async () => {
    const { provider, reviewerGraphql } = gitlabFixture();
    reviewerGraphql.mockResolvedValue({
      project: { mergeRequest: { approvalState: { rules: [] } } },
    });
    const snapshot = await provider.discover(
      { id: "repo", canonicalOrigin: "gitlab.example/org/project" },
      undefined,
      { id: "77", number: 8, projectId: "10" },
    );
    expect(snapshot.requirements).toHaveLength(1);
    expect(snapshot.requirements[0]).toMatchObject({
      name: "Suggested code owners · src/",
      requiredApprovals: 1,
      eligibleReviewerIds: ["1", "2"],
    });
  });

  test("routes additions through the fresh union-preserving GitLab mutation", async () => {
    const { provider, addMergeRequestReviewers } = gitlabFixture();
    await provider.assign(
      { id: "repo", canonicalOrigin: "gitlab.example/org/project" },
      { id: "77", number: 8, projectId: "10" },
      [
        {
          id: "3",
          username: "carol",
          name: "Carol",
          avatarUrl: null,
          url: null,
        },
      ],
    );
    expect(addMergeRequestReviewers).toHaveBeenCalledWith({
      projectId: "10",
      iid: 8,
      expectedId: "77",
      reviewerIds: ["3"],
    });
  });
});

test("owner pool identities ignore ordering and retain native provider identity", () => {
  expect(ownerPoolKey("GITHUB:github.com:1", ["team:2", "user:3"])).toBe(
    ownerPoolKey("GITHUB:github.com:1", ["user:3", "team:2", "team:2"]),
  );
  expect(ownerPoolKey("GITHUB:github.com:1", ["team:2"])).not.toBe(
    ownerPoolKey("GITHUB:github.com:2", ["team:2"]),
  );
});
