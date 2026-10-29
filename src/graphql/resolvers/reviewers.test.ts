import { expect, test, vi } from "vitest";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ReviewersService } from "@/services/reviewers/service";
import { canAssignReviewers, createReviewerResolvers } from "./reviewers";

test("reviewer operations reject agent credentials", () => {
  const service = {
    repositoryCodeReviewers: vi.fn(),
    worktreeReviewerAssignment: vi.fn(),
    previewRandomWorktreeReviewers: vi.fn(),
    saveRepositoryCodeReviewers: vi.fn(),
    assignWorktreeReviewers: vi.fn(),
  };
  const resolver = createReviewerResolvers(
    service as unknown as ReviewersService,
  );
  const context = { agentId: "agent" } as GraphQLContext;
  expect(() =>
    resolver.Query.repositoryCodeReviewers(
      null,
      { repositoryId: "repo" },
      context,
    ),
  ).toThrow("control-plane");
  expect(() =>
    resolver.Query.worktreeReviewerAssignment(
      null,
      { worktreeId: "w" },
      context,
    ),
  ).toThrow("control-plane");
  expect(() =>
    resolver.Query.previewRandomWorktreeReviewers(
      null,
      { worktreeId: "w", requestId: "p" },
      context,
    ),
  ).toThrow("control-plane");
  expect(() =>
    resolver.Mutation.saveRepositoryCodeReviewers(
      null,
      { input: { repositoryId: "repo", pools: [] } },
      context,
    ),
  ).toThrow("control-plane");
  expect(() =>
    resolver.Mutation.assignWorktreeReviewers(
      null,
      { input: { worktreeId: "w", requestId: "p", reviewerIds: ["person"] } },
      context,
    ),
  ).toThrow("control-plane");
  for (const method of Object.values(service))
    expect(method).not.toHaveBeenCalled();
});

test("availability only needs an open request and saved configuration", () => {
  const codebase = { repository: { hasConfiguredCodeReviewers: true } };
  expect(canAssignReviewers({ codebase, pullRequest: { state: "OPEN" } })).toBe(
    true,
  );
  expect(
    canAssignReviewers({ codebase, gitLabMergeRequest: { state: "opened" } }),
  ).toBe(true);
  expect(
    canAssignReviewers({ codebase, pullRequest: { state: "MERGED" } }),
  ).toBe(false);
  expect(canAssignReviewers({ pullRequest: { state: "OPEN" } })).toBe(false);
  expect(canAssignReviewers({ codebase })).toBe(false);
});
