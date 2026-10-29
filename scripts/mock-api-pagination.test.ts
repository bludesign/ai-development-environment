import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, test, vi } from "vitest";

import { mockActionsRuns } from "./mock-api-pagination";
import { mockGitLabApi } from "./mock-gitlab-api";
import { ids } from "./mock-data/ids";

describe("screenshot provider API fixtures", () => {
  test("filters Actions before counting and paginates independently of total count", () => {
    const runs = ["completed", "queued", "queued", "in_progress"].map(
      (status, id) => ({
        id,
        status,
        conclusion: status === "completed" ? "success" : null,
        head_branch: "main",
        pull_requests: [{ number: 42 }],
      }),
    );
    const result = mockActionsRuns(
      runs,
      new URLSearchParams(
        "status=queued&per_page=1&page=2&exclude_pull_requests=true",
      ),
    );
    expect(result.total_count).toBe(2);
    expect(result.workflow_runs).toMatchObject([
      { id: 2, status: "queued", pull_requests: [] },
    ]);
    expect(
      mockActionsRuns(runs, new URLSearchParams("status=pending")).total_count,
    ).toBe(0);
    expect(
      mockActionsRuns(runs, new URLSearchParams("status=success")).total_count,
    ).toBe(1);
  });

  test("serves the same active pipelines to summary scans and the Pipelines page", () => {
    const all = mockGitLabApi(
      `/projects/${ids.gitlab.projectId}/pipelines`,
      new URLSearchParams("per_page=1&page=2"),
    );
    expect(all.status).toBe(200);
    expect(all.headers).toMatchObject({ "x-total": "4", "x-next-page": "3" });
    expect(all.payload).toMatchObject([{ id: 9402, status: "pending" }]);
    for (const status of ["running", "pending"])
      expect(
        mockGitLabApi(
          `/projects/${ids.gitlab.projectId}/pipelines`,
          new URLSearchParams(`status=${status}&per_page=1`),
        ).headers,
      ).toMatchObject({ "x-total": "1", "x-next-page": "" });
    expect(
      mockGitLabApi(
        `/projects/${ids.gitlab.projectId}/pipelines`,
        new URLSearchParams("status=created&per_page=1"),
      ).headers,
    ).toMatchObject({ "x-total": "0" });
  });

  test("answers forced GitLab detail and approval reads from the fixture data", () => {
    const base = `/projects/${ids.gitlab.projectId}`;
    expect(
      mockGitLabApi(`${base}/pipelines/9403`, new URLSearchParams()).payload,
    ).toMatchObject({ id: 9403, status: "running" });
    expect(
      mockGitLabApi(
        `${base}/merge_requests/${ids.gitlab.mergeRequestIid}`,
        new URLSearchParams(),
      ).payload,
    ).toMatchObject({ state: "opened", head_pipeline: { id: 9401 } });
    expect(
      mockGitLabApi(
        `${base}/merge_requests/${ids.gitlab.mergeRequestIid}/approvals`,
        new URLSearchParams(),
      ).payload,
    ).toMatchObject({ approvals_left: 0, approved_by: [{ user: { id: 27 } }] });
  });

  test("redirects only the fixture GitLab API while preserving request credentials and options", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("ok"),
    );
    const context = {
      fetch,
      URL,
      Request,
      process: {
        env: { SCREENSHOT_GITLAB_API_ORIGIN: "http://127.0.0.1:4322" },
      },
    };
    const source = readFileSync(
      new URL("../playwright/mock-gitlab-fetch.cjs", import.meta.url),
      "utf8",
    );
    runInNewContext(source, context);
    await context.fetch(
      "https://gitlab.acme.example.com/gitlab/api/v4/projects/201/pipelines?status=running",
      { headers: { "private-token": "fixture" } },
    );
    expect(String(fetch.mock.calls[0][0])).toBe(
      "http://127.0.0.1:4322/gitlab/api/v4/projects/201/pipelines?status=running",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      headers: { "private-token": "fixture" },
    });
    const other = "https://gitlab.example.org/api/v4/projects/1/pipelines";
    await context.fetch(other);
    expect(fetch.mock.calls[1][0]).toBe(other);
  });
});
