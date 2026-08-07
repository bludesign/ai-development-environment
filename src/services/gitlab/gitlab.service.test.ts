import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  gitLabRestCacheKey,
  gitLabMutationRequestSummary,
  gitLabVersionSupported,
  gitLabWebhookRequestsReview,
  gitLabWebhookProjectId,
  gitLabWebhookTriggerKinds,
  mapGitLabDiscussion,
  mapGitLabPipelineStatus,
  normalizeGitLabBaseUrl,
  parseGitLabResponseHeaders,
  parseGitLabRateLimitHeaders,
  resolveGitLabPipelineBranch,
  serializeGitLabResponseHeaders,
  verifyGitLabWebhookSignature,
} from "./gitlab.service";

describe("GitLab service primitives", () => {
  test("normalizes GitLab.com and self-hosted relative roots", () => {
    expect(normalizeGitLabBaseUrl(" https://gitlab.com/ ")).toBe(
      "https://gitlab.com",
    );
    expect(normalizeGitLabBaseUrl("https://gitlab.example.com/gitlab///")).toBe(
      "https://gitlab.example.com/gitlab",
    );
  });

  test.each([
    "http://gitlab.example.com",
    "https://user:secret@gitlab.example.com",
    "https://gitlab.example.com?token=secret",
    "https://gitlab.example.com/#fragment",
  ])("rejects unsafe instance URL %s", (value) => {
    expect(() => normalizeGitLabBaseUrl(value)).toThrow();
  });

  test("enforces the supported GitLab version floor", () => {
    expect(gitLabVersionSupported("19.2.0-pre")).toBe(true);
    expect(gitLabVersionSupported("19.10.1-ee")).toBe(true);
    expect(gitLabVersionSupported("20.0.0")).toBe(true);
    expect(gitLabVersionSupported("19.1.9")).toBe(false);
    expect(gitLabVersionSupported("18.11.0")).toBe(false);
    expect(gitLabVersionSupported("unknown")).toBe(false);
  });

  test("maps every GitLab pipeline status and safely handles new values", () => {
    for (const status of [
      "created",
      "waiting_for_resource",
      "preparing",
      "pending",
      "running",
      "success",
      "failed",
      "canceled",
      "skipped",
      "manual",
      "scheduled",
    ]) {
      expect(mapGitLabPipelineStatus(status)).toBe(status.toUpperCase());
    }
    expect(mapGitLabPipelineStatus("future_status")).toBe("UNKNOWN");
  });

  test("defaults omitted discussion resolution state to unresolved", () => {
    const author = {
      id: 42,
      username: "reviewer",
      name: "Reviewer",
      avatar_url: "https://gitlab.com/uploads/reviewer.png",
      web_url: "https://gitlab.com/reviewer",
    };

    expect(
      mapGitLabDiscussion({
        id: "discussion-1",
        individual_note: true,
        notes: [
          {
            id: 101,
            body: "assigned to @reviewer",
            author,
            created_at: "2026-08-07T15:00:58.732Z",
            updated_at: "2026-08-07T15:00:58.734Z",
            system: true,
            resolvable: false,
          },
        ],
      }).notes[0]?.resolved,
    ).toBe(false);
  });

  test("resolves synthetic merge request refs to their source branch", () => {
    const mergeRequests = [
      {
        projectId: "project-1",
        iid: 17,
        title: "Improve retry diagnostics",
        webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
        sourceBranch: "feature/retry-diagnostics",
      },
    ];
    expect(
      resolveGitLabPipelineBranch(
        { ref: "refs/merge-requests/17/head", source: "merge_request_event" },
        mergeRequests,
      ),
    ).toBe("feature/retry-diagnostics");
    expect(
      resolveGitLabPipelineBranch(
        { ref: "feature/retry-diagnostics", source: "push" },
        mergeRequests,
      ),
    ).toBe("feature/retry-diagnostics");
    expect(
      resolveGitLabPipelineBranch({ ref: "main", source: "push" }, []),
    ).toBe("main");
  });

  test("parses rate limits and request IDs", () => {
    const parsed = parseGitLabRateLimitHeaders(
      new Headers({
        "ratelimit-limit": "600",
        "ratelimit-remaining": "599",
        "ratelimit-reset": "1800000000",
        "x-request-id": "request-1",
      }),
    );
    expect(parsed).toEqual({
      limit: 600,
      remaining: 599,
      resetAt: new Date(1_800_000_000_000),
      requestId: "request-1",
    });
  });

  test("builds stable cache keys scoped by instance and operation", () => {
    const first = gitLabRestCacheKey({
      baseUrl: "https://gitlab.example.com/gitlab",
      operation: "MergeRequests",
      path: "/projects/1/merge_requests",
      query: { labels: ["backend", "api"], page: 1 },
    });
    const reordered = gitLabRestCacheKey({
      baseUrl: "https://gitlab.example.com/gitlab",
      operation: "MergeRequests",
      path: "/projects/1/merge_requests",
      query: { page: 1, labels: ["api", "backend"] },
    });
    expect(reordered).toBe(first);
    expect(
      gitLabRestCacheKey({
        baseUrl: "https://gitlab.example.com/gitlab",
        operation: "MergeRequestDetails",
        path: "/projects/1/merge_requests",
        query: { page: 1, labels: ["api", "backend"] },
      }),
    ).not.toBe(first);
    expect(
      gitLabRestCacheKey({
        baseUrl: "https://another.example.com",
        operation: "MergeRequests",
        path: "/projects/1/merge_requests",
        query: { page: 1, labels: ["api", "backend"] },
      }),
    ).not.toBe(first);
  });

  test("redacts secrets and CI variable values from mutation audit summaries", () => {
    const summary = gitLabMutationRequestSummary({
      ref: "main",
      signing_token: "whsec-sensitive",
      variables: [
        { key: "DEPLOY_TOKEN", value: "pipeline-secret" },
        { key: "ENVIRONMENT", value: "production" },
      ],
    });

    expect(JSON.parse(summary)).toEqual({
      ref: "main",
      signing_token: "[REDACTED]",
      variables: [
        { key: "DEPLOY_TOKEN", value: "[REDACTED]" },
        { key: "ENVIRONMENT", value: "[REDACTED]" },
      ],
    });
    expect(summary).not.toContain("whsec-sensitive");
    expect(summary).not.toContain("pipeline-secret");
  });

  test("round-trips cached response headers used for pagination", () => {
    const serialized = serializeGitLabResponseHeaders(
      new Headers({
        "x-next-page": "2",
        "x-total": "51",
        "x-request-id": "request-1",
      }),
    );
    const restored = parseGitLabResponseHeaders(serialized);
    expect(restored.get("x-next-page")).toBe("2");
    expect(restored.get("x-total")).toBe("51");
    expect(restored.get("x-request-id")).toBe("request-1");
    expect([...parseGitLabResponseHeaders("not-json")]).toEqual([]);
  });

  test("classifies merge request updates by their changed fields", () => {
    const payload = (extra: Record<string, unknown>) => ({
      object_kind: "merge_request",
      object_attributes: { action: "update" },
      ...extra,
    });
    expect(
      gitLabWebhookTriggerKinds(
        payload({ changes: { title: { previous: "A", current: "B" } } }),
      ),
    ).toEqual([]);
    expect(
      gitLabWebhookTriggerKinds(
        payload({
          object_attributes: { action: "update", oldrev: "previous-sha" },
        }),
      ),
    ).toEqual(["GITLAB_MR_SYNCHRONIZED"]);
    expect(
      gitLabWebhookTriggerKinds(
        payload({ changes: { labels: { previous: [], current: ["bug"] } } }),
      ),
    ).toEqual(["GITLAB_MR_LABEL"]);
    expect(
      gitLabWebhookTriggerKinds(
        payload({ changes: { draft: { previous: true, current: false } } }),
      ),
    ).toEqual(["GITLAB_MR_STATE"]);
  });

  test("ignores non-merge-request notes when classifying workflow events", () => {
    const note = {
      object_kind: "note",
      object_attributes: {
        note: "/submit_review approve",
        noteable_type: "Issue",
      },
      issue: { id: 42 },
    };
    expect(gitLabWebhookTriggerKinds(note)).toEqual([]);
    expect(
      gitLabWebhookTriggerKinds({
        ...note,
        object_attributes: {
          ...note.object_attributes,
          noteable_type: "MergeRequest",
        },
        merge_request: { id: 7, iid: 3 },
      }),
    ).toEqual([
      "GITLAB_REVIEW_COMMENT",
      "GITLAB_NOTE_COMMAND",
      "GITLAB_REVIEW_APPROVED",
    ]);
  });

  test("detects only review requests targeting the configured viewer", () => {
    const viewer = { id: "7", username: "reviewer" };
    expect(
      gitLabWebhookRequestsReview(
        {
          object_kind: "merge_request",
          object_attributes: { action: "open" },
          reviewers: [{ id: 8, username: "someone-else" }],
        },
        viewer,
      ),
    ).toBe(false);
    expect(
      gitLabWebhookRequestsReview(
        {
          object_kind: "merge_request",
          object_attributes: { action: "open" },
          reviewers: [{ id: 7, username: "reviewer" }],
        },
        viewer,
      ),
    ).toBe(true);
    expect(
      gitLabWebhookRequestsReview(
        {
          object_kind: "merge_request",
          object_attributes: { action: "approved" },
          reviewers: [{ id: 7, username: "reviewer" }],
        },
        viewer,
      ),
    ).toBe(false);
    expect(
      gitLabWebhookRequestsReview(
        {
          object_kind: "merge_request",
          object_attributes: { action: "update" },
          changes: {
            reviewers: [
              [{ id: 8, username: "someone-else" }],
              [{ id: 7, username: "reviewer", state: "unreviewed" }],
            ],
          },
        },
        viewer,
      ),
    ).toBe(true);
    expect(
      gitLabWebhookRequestsReview(
        {
          object_kind: "merge_request",
          object_attributes: { action: "update" },
          changes: {
            reviewers: {
              previous: [{ id: 7, username: "reviewer" }],
              current: [{ id: 7, username: "reviewer", re_requested: true }],
            },
          },
        },
        viewer,
      ),
    ).toBe(true);
  });

  test("selects the project secret from both supported payload shapes", () => {
    expect(gitLabWebhookProjectId({ project: { id: 42 } })).toBe("42");
    expect(gitLabWebhookProjectId({ project_id: 84 })).toBe("84");
    expect(gitLabWebhookProjectId({})).toBeNull();
  });

  test("verifies Standard Webhook HMAC signatures and replay timing", () => {
    const rawBody = JSON.stringify({ object_kind: "pipeline" });
    const webhookId = "message-1";
    const timestamp = "1800000000";
    const key = Buffer.from("test signing key");
    const signingToken = `whsec_${key.toString("base64")}`;
    const signature = `v1,${createHmac("sha256", key)
      .update(`${webhookId}.${timestamp}.${rawBody}`)
      .digest("base64")}`;

    expect(() =>
      verifyGitLabWebhookSignature({
        rawBody,
        webhookId,
        timestamp,
        signature,
        signingToken,
        now: 1_800_000_000_000,
      }),
    ).not.toThrow();
    expect(() =>
      verifyGitLabWebhookSignature({
        rawBody,
        webhookId,
        timestamp,
        signature: "v1,ZmFrZQ==",
        signingToken,
        now: 1_800_000_000_000,
      }),
    ).toThrow("Invalid GitLab webhook signature");
    expect(() =>
      verifyGitLabWebhookSignature({
        rawBody,
        webhookId,
        timestamp,
        signature,
        signingToken,
        now: 1_800_000_301_000,
      }),
    ).toThrow("outside the replay window");
  });
});
