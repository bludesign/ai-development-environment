import * as z from "zod/v4";

import type { GitLabService } from "@/services/gitlab";

import {
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

const projectMergeRequest = z.object({
  projectId: z.string().min(1),
  iid: z.number().int().positive(),
});

export function createGitLabToolGroup(
  service: GitLabService,
): BuiltInToolGroup {
  return {
    id: "builtin:gitlab",
    name: "GitLab",
    children: [],
    tools: [
      serviceTool({
        name: "gitlab_get_status",
        title: "Get GitLab status",
        description: "Test the configured GitLab connection.",
        inputSchema: z.object({}),
        service,
        method: "testConnection",
        arguments: () => [],
        resultKey: "status",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_get_projects",
        title: "Get GitLab projects",
        description: "List the GitLab projects managed by AIDE.",
        inputSchema: z.object({}),
        service,
        method: "projects",
        arguments: () => [],
        resultKey: "projects",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_get_merge_requests",
        title: "Get GitLab merge requests",
        description: "List accessible GitLab merge requests.",
        inputSchema: z.object({
          scope: z.enum(["MINE", "REVIEW_REQUESTED", "PROJECT", "ALL"]),
          projectId: z.string().nullable().optional(),
          state: z
            .enum(["OPENED", "CLOSED", "MERGED", "ALL"])
            .default("OPENED"),
          page: z.number().int().positive().default(1),
          perPage: z.number().int().min(1).max(100).default(25),
        }),
        service,
        method: "mergeRequests",
        resultKey: "page",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_get_merge_request",
        title: "Get GitLab merge request",
        description: "Get a merge request with discussions and pipelines.",
        inputSchema: projectMergeRequest,
        service,
        method: "mergeRequest",
        arguments: ({ projectId, iid }) => [projectId, iid],
        resultKey: "mergeRequest",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_create_merge_request",
        title: "Create GitLab merge request",
        description: "Create a GitLab merge request.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          sourceBranch: z.string().min(1),
          targetBranch: z.string().min(1),
          title: z.string().min(1),
          description: z.string().nullable().optional(),
          removeSourceBranch: z.boolean().nullable().optional(),
          squash: z.boolean().nullable().optional(),
          reviewerIds: z.array(z.string()).nullable().optional(),
          labels: z.array(z.string()).nullable().optional(),
        }),
        service,
        method: "createMergeRequest",
        resultKey: "mergeRequest",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "gitlab_update_merge_request",
        title: "Update GitLab merge request",
        description: "Update title, description, state, labels, or reviewers.",
        inputSchema: projectMergeRequest.extend({
          title: z.string().nullable().optional(),
          description: z.string().nullable().optional(),
          stateEvent: z.enum(["CLOSE", "REOPEN"]).nullable().optional(),
          reviewerIds: z.array(z.string()).nullable().optional(),
          labels: z.array(z.string()).nullable().optional(),
        }),
        service,
        method: "updateMergeRequest",
        resultKey: "mergeRequest",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_submit_review",
        title: "Submit GitLab review",
        description:
          "Approve, comment on, or request changes on a merge request.",
        inputSchema: projectMergeRequest.extend({
          outcome: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
          body: z.string().nullable().optional(),
        }),
        service,
        method: "submitReview",
        resultKey: "submitted",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "gitlab_reply_discussion",
        title: "Reply to GitLab discussion",
        description: "Reply to a merge-request discussion.",
        inputSchema: projectMergeRequest.extend({
          discussionId: z.string().min(1),
          body: z.string().min(1),
        }),
        service,
        method: "replyToDiscussion",
        resultKey: "discussion",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "gitlab_set_discussion_resolved",
        title: "Resolve GitLab discussion",
        description: "Resolve or reopen a merge-request discussion.",
        inputSchema: projectMergeRequest.extend({
          discussionId: z.string().min(1),
          resolved: z.boolean(),
        }),
        service,
        method: "setDiscussionResolved",
        resultKey: "discussion",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_merge_merge_request",
        title: "Merge GitLab merge request",
        description:
          "Merge now or enable auto-merge for a GitLab merge request.",
        inputSchema: projectMergeRequest.extend({
          squash: z.boolean().nullable().optional(),
          removeSourceBranch: z.boolean().nullable().optional(),
          autoMerge: z.boolean().nullable().optional(),
          sha: z.string().nullable().optional(),
        }),
        service,
        method: "mergeMergeRequest",
        resultKey: "mergeRequest",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_get_pipelines",
        title: "Get GitLab pipelines",
        description: "List pipelines for a GitLab project.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          page: z.number().int().positive().default(1),
          perPage: z.number().int().min(1).max(100).default(25),
        }),
        service,
        method: "pipelines",
        arguments: ({ projectId, page, perPage }) => [projectId, page, perPage],
        resultKey: "page",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_get_pipeline_jobs",
        title: "Get GitLab pipeline jobs",
        description: "List jobs for a GitLab pipeline.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          pipelineId: z.string().min(1),
        }),
        service,
        method: "pipelineJobs",
        arguments: ({ projectId, pipelineId }) => [projectId, pipelineId],
        resultKey: "jobs",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_create_pipeline",
        title: "Create GitLab pipeline",
        description: "Create a pipeline for a ref and optional variables.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          ref: z.string().min(1),
          variables: z
            .array(z.object({ key: z.string().min(1), value: z.string() }))
            .default([]),
        }),
        service,
        method: "createPipeline",
        arguments: ({ projectId, ref, variables }) => [
          projectId,
          ref,
          variables,
        ],
        resultKey: "pipeline",
        annotations: { ...WRITE_EXTERNAL_ANNOTATIONS, idempotentHint: false },
      }),
      serviceTool({
        name: "gitlab_retry_pipeline",
        title: "Retry GitLab pipeline",
        description: "Retry failed or canceled jobs in a GitLab pipeline.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          pipelineId: z.string().min(1),
        }),
        service,
        method: "retryPipeline",
        arguments: ({ projectId, pipelineId }) => [projectId, pipelineId],
        resultKey: "pipeline",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_cancel_pipeline",
        title: "Cancel GitLab pipeline",
        description: "Cancel a running GitLab pipeline.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          pipelineId: z.string().min(1),
        }),
        service,
        method: "cancelPipeline",
        arguments: ({ projectId, pipelineId }) => [projectId, pipelineId],
        resultKey: "pipeline",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "gitlab_retry_job",
        title: "Retry GitLab job",
        description: "Retry a failed or canceled GitLab job.",
        inputSchema: z.object({
          projectId: z.string().min(1),
          jobId: z.string().min(1),
        }),
        service,
        method: "retryJob",
        arguments: ({ projectId, jobId }) => [projectId, jobId],
        resultKey: "job",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
    ],
  };
}
