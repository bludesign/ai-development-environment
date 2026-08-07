import { describe, expect, test, vi } from "vitest";

import { createGitHubToolGroup } from "./github";
import { createGitLabToolGroup } from "./gitlab";
import { createJiraToolGroup } from "./jira";

const tool = (
  group:
    | ReturnType<typeof createGitHubToolGroup>
    | ReturnType<typeof createGitLabToolGroup>
    | ReturnType<typeof createJiraToolGroup>,
  name: string,
) => group.tools.find((candidate) => candidate.name === name)!;

describe("provider action tools", () => {
  test("parses and invokes GitHub pull-request and dispatch operations", async () => {
    const updatePullRequest = vi.fn().mockResolvedValue({ id: "pr-1" });
    const submitPullRequestReview = vi.fn().mockResolvedValue({ id: "pr-1" });
    const requestPullRequestReviewers = vi
      .fn()
      .mockResolvedValue({ id: "pr-1" });
    const dispatchWorkflow = vi.fn().mockResolvedValue(true);
    const group = createGitHubToolGroup({
      updatePullRequest,
      submitPullRequestReview,
      requestPullRequestReviewers,
      dispatchWorkflow,
    } as never);

    await tool(group, "update_pull_request").invoke({
      owner: "acme",
      name: "app",
      number: 12,
      title: "Updated",
    });
    await tool(group, "submit_pull_request_review").invoke({
      owner: "acme",
      name: "app",
      number: 12,
      event: "APPROVE",
    });
    await tool(group, "request_pull_request_reviewers").invoke({
      owner: "acme",
      name: "app",
      number: 12,
      reviewers: ["octocat"],
    });
    await tool(group, "dispatch_github_workflow").invoke({
      repositoryId: "repo-1",
      workflowId: "ci.yml",
      ref: "main",
    });

    expect(updatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ number: 12, title: "Updated" }),
    );
    expect(submitPullRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: "APPROVE" }),
    );
    expect(requestPullRequestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: ["octocat"], teamReviewers: [] }),
    );
    expect(dispatchWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1", ref: "main" }),
    );
  });

  test("parses and invokes GitLab merge-request and pipeline operations", async () => {
    const updateMergeRequest = vi.fn().mockResolvedValue({ id: "mr-1" });
    const submitReview = vi.fn().mockResolvedValue(true);
    const mergeMergeRequest = vi.fn().mockResolvedValue({ id: "mr-1" });
    const pipeline = vi.fn().mockResolvedValue({ id: "pipeline-1" });
    const createPipeline = vi.fn().mockResolvedValue({ id: "pipeline-1" });
    const retryJob = vi.fn().mockResolvedValue({ id: "job-1" });
    const saveAutoRetryRule = vi.fn().mockResolvedValue({ id: "rule-1" });
    const rateLimitSnapshots = vi.fn().mockResolvedValue([]);
    const group = createGitLabToolGroup({
      updateMergeRequest,
      submitReview,
      mergeMergeRequest,
      pipeline,
      createPipeline,
      retryJob,
      saveAutoRetryRule,
      rateLimitSnapshots,
    } as never);

    await tool(group, "gitlab_set_merge_request_labels").invoke({
      projectId: "42",
      iid: 1,
      labels: ["ready"],
    });
    await tool(group, "gitlab_request_merge_request_reviewers").invoke({
      projectId: "42",
      iid: 1,
      reviewerIds: ["7"],
    });
    await tool(group, "gitlab_submit_review").invoke({
      projectId: "42",
      iid: 1,
      outcome: "APPROVE",
    });
    await tool(group, "gitlab_merge_merge_request").invoke({
      projectId: "42",
      iid: 1,
      squash: true,
    });
    await tool(group, "gitlab_create_pipeline").invoke({
      projectId: "42",
      ref: "main",
      variables: [{ key: "DEPLOY", value: "true" }],
    });
    await tool(group, "gitlab_retry_job").invoke({
      projectId: "42",
      jobId: "9",
    });
    await tool(group, "gitlab_get_pipeline").invoke({
      projectId: "42",
      pipelineId: "11",
    });
    await tool(group, "gitlab_save_auto_retry_rule").invoke({
      projectId: "42",
      pipelineId: "11",
      maxAttempts: 3,
    });
    await tool(group, "gitlab_get_rate_limits").invoke({});

    expect(updateMergeRequest).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ labels: ["ready"] }),
    );
    expect(updateMergeRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ reviewerIds: ["7"] }),
    );
    expect(submitReview).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "APPROVE" }),
    );
    expect(mergeMergeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ squash: true }),
    );
    expect(createPipeline).toHaveBeenCalledWith("42", "main", [
      { key: "DEPLOY", value: "true" },
    ]);
    expect(retryJob).toHaveBeenCalledWith("42", "9");
    expect(pipeline).toHaveBeenCalledWith("42", "11");
    expect(saveAutoRetryRule).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "42", maxAttempts: 3 }),
    );
    expect(rateLimitSnapshots).toHaveBeenCalledWith();
  });

  test("parses and invokes Jira issue creation, worklog, and linking operations", async () => {
    const createTicket = vi.fn().mockResolvedValue({ key: "AIDE-1" });
    const addWorklog = vi.fn().mockResolvedValue({ key: "AIDE-1" });
    const linkTickets = vi.fn().mockResolvedValue({ key: "AIDE-1" });
    const group = createJiraToolGroup(
      { createTicket, addWorklog, linkTickets } as never,
      {} as never,
    );

    await tool(group, "create_jira_ticket").invoke({
      projectKey: "AIDE",
      issueTypeId: "10001",
      summary: "Add tools",
    });
    await tool(group, "add_jira_worklog").invoke({
      issueKey: "AIDE-1",
      timeSpentSeconds: 900,
    });
    await tool(group, "link_jira_tickets").invoke({
      inwardIssueKey: "AIDE-1",
      outwardIssueKey: "AIDE-2",
      linkType: "Relates",
    });

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: "AIDE", summary: "Add tools" }),
    );
    expect(addWorklog).toHaveBeenCalledWith(
      expect.objectContaining({ issueKey: "AIDE-1", timeSpentSeconds: 900 }),
    );
    expect(linkTickets).toHaveBeenCalledWith(
      expect.objectContaining({ outwardIssueKey: "AIDE-2" }),
    );
  });
});
