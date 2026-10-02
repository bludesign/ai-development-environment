// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import {
  externalPipelineExampleContext,
  externalPipelineScriptExample,
} from "@/lib/external-pipeline-script-examples";
import { runScript } from "@/services/scripts/runtime";

afterEach(() => vi.unstubAllGlobals());

const secretValues = {
  API_TOKEN: "private-token-value",
  ACTION_BASE_URL: "https://ci.example.com/actions/",
};

async function execute(
  action: "retry" | "cancel",
  example: "context" | "http",
  overrides: Record<string, unknown> = {},
) {
  return runScript({
    source: externalPipelineScriptExample(action, example),
    mode: "external",
    context: {
      ...externalPipelineExampleContext,
      action,
      secrets: secretValues,
      ...overrides,
    },
    secrets: Object.values(secretValues),
    timeoutMs: 1000,
    fetchTimeoutMs: 100,
    memoryLimitMb: 32,
  });
}

test.each(["retry", "cancel"] as const)(
  "%s context example explicitly invokes its function, displays arguments, and omits secret values",
  async (action) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const context = externalPipelineExampleContext;
    const selectedJob = action === "cancel" ? context.externalJobs[0] : null;
    const result = await execute(action, "context", { job: selectedJob });
    expect(result.result).toMatchObject({
      dryRun: true,
      version: 1,
      action,
      origin: "manual",
      pipeline: { sha: "abc123", resolvedBranch: "feature/tests" },
      repository: context.repository,
      project: context.project,
      gitlab: context.gitlab,
      externalJobs: context.externalJobs,
      job: selectedJob,
      mergeRequest: context.mergeRequest,
      mergeRequests: context.mergeRequests,
      secretNames: ["API_TOKEN", "ACTION_BASE_URL"],
    });
    expect(result.console).toHaveLength(1);
    expect(JSON.stringify([result.result, result.console])).not.toContain(
      "private-token-value",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(["retry", "cancel"] as const)(
  "%s HTTP example invokes the function once per unique provider run and preserves commit and MR context",
  async (action) => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const context = externalPipelineExampleContext;
    const result = await execute(action, "http", {
      externalJobs: [
        context.externalJobs[0],
        { ...context.externalJobs[0], id: "101" },
      ],
      job: context.externalJobs[0],
      mergeRequest: { ...context.mergeRequest, sourceProjectId: "22" },
    });
    expect(result.result).toEqual({ requested: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([String(fetch.mock.calls[0][0]), fetch.mock.calls[0][1]]).toEqual([
      "https://ci.example.com/actions/" + action,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer private-token-value",
        }),
      }),
    ]);
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      runUrl: "https://ci.example.com/runs/123",
      sha: "abc123",
      branch: "feature/tests",
      projectId: "21",
      jobId: "100",
      mergeRequest: { iid: 2, sourceProjectId: "22", targetProjectId: "21" },
    });
  },
);

test.each([
  [{ secrets: {} }, "Configure ACTION_BASE_URL and API_TOKEN secrets first"],
  [
    { externalJobs: [{ targetUrl: null }] },
    "Resolve missing run URLs with your provider API first",
  ],
])(
  "HTTP example validates configuration before requests",
  async (context, message) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(execute("retry", "http", context)).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("HTTP example treats a provider rejection as a failed request", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );
  await expect(execute("cancel", "http")).rejects.toThrow("Provider HTTP 503");
});
