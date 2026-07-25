import { describe, expect, test } from "vitest";

import {
  githubJobWorkflowResource,
  githubPipelineWorkflowResource,
} from "./workflow-resource-context";

const pipeline = {
  id: "check-suite-1",
  workflowRunId: "run-1",
  workflowId: "workflow-1",
  codebaseRepositoryId: "repository-1",
  repositoryGithubId: "github-repository-1",
  repositoryNameWithOwner: "acme/widgets",
  repositoryUrl: "https://github.com/acme/widgets",
  name: "CI",
  status: "SUCCESS" as const,
  url: "https://github.com/acme/widgets/actions/runs/1",
  pullRequests: [
    { number: 12, url: "https://github.com/acme/widgets/pull/12" },
    { number: 13, url: "https://github.com/acme/widgets/pull/13" },
  ],
};

describe("GitHub workflow resources", () => {
  test("keeps every pipeline PR association while preferring explicit context", () => {
    const resource = githubPipelineWorkflowResource(pipeline, {
      pullRequest: {
        id: "pull-request-99",
        number: 99,
        title: "Current pull request",
        url: "https://github.com/acme/widgets/pull/99",
        jiraKey: "APP-99",
      },
      worktree: { id: "worktree-1", branch: "feature/APP-99" },
    });

    expect(resource.id).toBe("repository-1:run:run-1");
    expect(resource.sessionData).toMatchObject({
      pipeline: { pullRequests: pipeline.pullRequests },
      pr: { id: "pull-request-99", number: 99 },
      worktree: { id: "worktree-1" },
      ticket: { key: "APP-99" },
    });
  });

  test("uses check-suite and job IDs when no workflow run exists", () => {
    const pipelineResource = githubPipelineWorkflowResource({
      ...pipeline,
      workflowRunId: null,
    });
    const jobResource = githubJobWorkflowResource(
      pipelineResource,
      {
        id: "job-44",
        name: "Test",
        status: "FAILURE",
        url: "https://github.com/acme/widgets/actions/jobs/44",
      },
      pipeline.codebaseRepositoryId,
      pipeline.repositoryGithubId,
    );

    expect(pipelineResource.id).toBe("repository-1:check:check-suite-1");
    expect(jobResource.id).toBe("repository-1:job:job-44");
    expect(jobResource.sessionData).toMatchObject({
      pipeline: { id: "check-suite-1" },
      job: { id: "job-44", name: "Test", status: "FAILURE" },
    });
  });

  test("defers primary PR selection to a connected worktree", () => {
    const resource = githubPipelineWorkflowResource({
      ...pipeline,
      worktreeId: "worktree-1",
    });

    expect(resource.sessionData).not.toHaveProperty("pr");
    expect(resource.sessionData).toMatchObject({
      worktree: { id: "worktree-1" },
      pipeline: { pullRequests: pipeline.pullRequests },
    });
  });
});
