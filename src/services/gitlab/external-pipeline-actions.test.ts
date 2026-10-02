// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  test,
  expect,
  vi,
} from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { CredentialService } from "@/services/credentials";
import {
  ExternalPipelineActionsService,
  externalIdentity,
  hashActionKey,
} from "./external-pipeline-actions";
import { combineExternalStatuses } from "./external-statuses";
import type { GitLabJobView, GitLabPipelineView } from "./types";
import { runScript, ScriptExecutionError } from "@/services/scripts/runtime";

let directory: string,
  prisma: PrismaClient,
  service: ExternalPipelineActionsService,
  databaseCount = 0;
const pipeline: GitLabPipelineView = {
  id: "94",
  projectId: "21",
  iid: "1",
  ref: "refs/merge-requests/2/head",
  branch: "feature/test",
  sha: "abc123",
  source: "merge_request_event",
  status: "FAILED",
  webUrl: "https://gitlab.example/group/repo/-/pipelines/94",
  mergeRequests: [
    {
      projectId: "21",
      targetProjectId: "21",
      sourceProjectId: "22",
      iid: 2,
      title: "Fork MR",
      webUrl: "https://gitlab.example/group/repo/-/merge_requests/2",
      sourceBranch: "feature/test",
      targetBranch: "main",
    },
  ],
  worktreeId: null,
  worktreeHighlightColor: null,
  createdAt: null,
  updatedAt: null,
  startedAt: null,
  finishedAt: null,
  duration: null,
  queuedDuration: null,
};
const job = (id = "100"): GitLabJobView => ({
  id,
  pipelineId: "94",
  kind: "EXTERNAL",
  name: "ci/test",
  stage: "external",
  status: "FAILED",
  ref: pipeline.ref,
  webUrl: "https://ci.example/run/123",
  targetUrl: "https://ci.example/run/123",
  author: { id: "7", username: "ci", name: "CI", avatarUrl: null, webUrl: "" },
  retried: false,
  allowFailure: false,
  createdAt: new Date(0).toISOString(),
  startedAt: null,
  finishedAt: null,
  duration: null,
  queuedDuration: null,
});
const execute = (
  overrides: Partial<
    Parameters<ExternalPipelineActionsService["execute"]>[0]
  > = {},
) =>
  service.execute({
    projectId: "21",
    pipeline,
    jobs: [job()],
    action: "RETRY",
    origin: "MANUAL",
    baseUrl: "https://gitlab.example",
    ...overrides,
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aide-external-pipelines-"));
});
beforeEach(async () => {
  const path = join(directory, `test-${++databaseCount}.db`);
  const db = new Database(path);
  for (const migration of (await readdir("prisma/migrations")).sort())
    if (/^\d/.test(migration))
      db.exec(
        await readFile(
          join("prisma/migrations", migration, "migration.sql"),
          "utf8",
        ),
      );
  db.close();
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: path }),
  });
  service = new ExternalPipelineActionsService(
    async () => prisma,
    new CredentialService({
      prisma,
      env: {
        CREDENTIAL_STORAGE_TYPE: "database",
        APP_SECRET: randomBytes(32).toString("base64"),
      },
    }),
  );
  await prisma.codebaseRepository.create({
    data: {
      id: "repo",
      name: "repo",
      canonicalOrigin: "gitlab.example/group/repo",
      displayOrigin: "git@gitlab.example:group/repo.git",
    },
  });
  await prisma.gitLabProject.create({
    data: {
      id: "21",
      name: "repo",
      pathWithNamespace: "group/repo",
      visibility: "private",
      webUrl: "https://gitlab.example/group/repo",
    },
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await prisma?.$disconnect();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function configure(source = "return {requested: true};") {
  await service.saveConfiguration("repo", {
    enabled: true,
    retryScript: source,
    cancelScript: source,
  });
}

test("configuration defaults off and secrets are encrypted, replaceable, deletable and never returned", async () => {
  expect(await service.configuration("repo")).toMatchObject({
    enabled: false,
    secretNames: [],
  });
  await service.setSecret("repo", "TOKEN", "original-secret");
  expect(JSON.stringify(await service.configuration("repo"))).not.toContain(
    "original-secret",
  );
  const credential = await prisma.credential.findFirstOrThrow();
  expect(credential.encrypted).toBe(true);
  expect(Buffer.from(credential.payload!).toString()).not.toContain(
    "original-secret",
  );
  await service.setSecret("repo", "TOKEN", "new-secret");
  await configure(
    "console.log(context.secrets.TOKEN); return context.secrets.TOKEN;",
  );
  const result = await execute();
  expect(result.status).toBe("ACCEPTED");
  expect(result.output).toContain("[REDACTED]");
  expect(result.output).not.toContain("new-secret");
  await service.setSecret("repo", "TOKEN", null);
  expect((await service.configuration("repo")).secretNames).toEqual([]);
});
test("missing configuration prevents native work before dispatch", async () => {
  const native = vi.fn();
  await expect(execute({ native })).rejects.toThrow("Configure and enable");
  expect(native).not.toHaveBeenCalled();
  await configure("");
  await expect(execute({ native })).rejects.toThrow("Configure and enable");
  expect(native).not.toHaveBeenCalled();
});
test("canonical repository context includes synthetic refs, fork MR identity and selected job without app credentials", async () => {
  await configure(
    "return {version: context.version, action: context.action, origin: context.origin, repository: context.repository, gitlab: context.gitlab, project: context.project, pipeline: context.pipeline, mr: context.mergeRequest, mrs: context.mergeRequests, jobs: context.externalJobs, job: context.job, secrets: Object.keys(context.secrets)};",
  );
  const result = await execute({ selectedJob: job(), origin: "WORKFLOW" });
  const context = JSON.parse(result.output!).result;
  expect(context).toMatchObject({
    version: 1,
    action: "retry",
    origin: "workflow",
    repository: { id: "repo" },
    pipeline: { rawRef: pipeline.ref, resolvedBranch: pipeline.branch },
    mr: { iid: 2, sourceProjectId: "22", targetProjectId: "21" },
    job: { id: "100" },
    secrets: [],
  });
  expect(context.jobs).toHaveLength(1);
});
test("absent and ambiguous branch associations provide null unique MR and keep all matches", async () => {
  await configure(
    "return {mr: context.mergeRequest, mrs: context.mergeRequests};",
  );
  const ambiguous = {
    ...pipeline,
    ref: "feature/test",
    mergeRequests: [
      pipeline.mergeRequests[0],
      { ...pipeline.mergeRequests[0], iid: 3 },
    ],
  };
  expect(
    JSON.parse((await execute({ pipeline: ambiguous })).output!).result,
  ).toMatchObject({ mr: null, mrs: expect.any(Array) });
  const absent = { ...pipeline, sha: "different", mergeRequests: [] };
  expect(
    JSON.parse((await execute({ pipeline: absent })).output!).result,
  ).toEqual({ mr: null, mrs: [] });
});
test("concurrent pipeline and individual clicks claim overlapping statuses durably", async () => {
  await configure(
    'await fetch("https://ci.example/retry"); return "requested";',
  );
  let finish!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const first = execute({ jobs: [job(), { ...job("101"), name: "ci/other" }] });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const duplicate = await execute({ selectedJob: job() });
  expect(duplicate.status).toBe("RUNNING");
  finish(new Response("ok"));
  const accepted = await first;
  expect(accepted.status).toBe("ACCEPTED");
  expect((await execute()).id).toBe(accepted.id);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("partial failure retries the failed external component without sending accepted native work again", async () => {
  await configure('throw new Error("Provider rejected request");');
  const native = vi.fn();
  expect(await execute({ native })).toMatchObject({
    status: "PARTIAL",
    nativeStatus: "ACCEPTED",
    externalStatus: "FAILED",
  });
  await configure();
  expect((await execute({ native })).status).toBe("ACCEPTED");
  expect(native).toHaveBeenCalledTimes(1);
});
test("partial native failures retry native work without repeating an accepted external request", async () => {
  await configure('await fetch("https://ci.example/retry");');
  const fetch = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetch);
  const native = vi
    .fn()
    .mockRejectedValueOnce(new Error("Rejected"))
    .mockResolvedValueOnce(undefined);
  expect((await execute({ native })).status).toBe("PARTIAL");
  expect((await execute({ native })).status).toBe("ACCEPTED");
  expect(native).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("HTTP errors and secret-bearing runtime errors are sanitized and retained", async () => {
  await service.setSecret("repo", "TOKEN", "super-secret");
  await configure(
    'console.error(context.secrets.TOKEN); const response = await fetch("https://ci.example/retry"); if (!response.ok) throw new Error(context.secrets.TOKEN + " HTTP " + response.status);',
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("failure", { status: 401 })),
  );
  const result = await execute();
  expect(result.status).toBe("FAILED");
  expect(JSON.stringify(result)).not.toContain("super-secret");
  expect(result.message).toContain("HTTP 401");
  expect(result.output).toContain("[REDACTED]");
});
test("external identity attempt limits survive replacement statuses and GitLab pipeline IDs without replaying old failures", async () => {
  const rule = { id: "rule", maxAttempts: 2 };
  expect(await service.automaticJobs(rule, pipeline, [job()])).toHaveLength(1);
  await service.finishAutomatic(rule.id, pipeline, [job()], "ACCEPTED");
  expect(await service.automaticJobs(rule, pipeline, [job()])).toHaveLength(0);
  const replacement = { ...job("102"), pipelineId: "95" };
  const nextPipeline = { ...pipeline, id: "95" };
  expect(
    await service.automaticJobs(rule, nextPipeline, [replacement]),
  ).toHaveLength(1);
  await service.finishAutomatic(
    rule.id,
    nextPipeline,
    [replacement],
    "UNCERTAIN",
  );
  expect(await service.automaticJobs(rule, pipeline, [job()])).toHaveLength(0);
  expect(
    await service.automaticJobs(rule, { ...pipeline, id: "96" }, [job("103")]),
  ).toHaveLength(0);
  expect(
    await prisma.externalPipelineRetryState.findUniqueOrThrow({
      where: {
        key: hashActionKey([
          rule.id,
          externalIdentity("repo", pipeline, job()),
        ]),
      },
    }),
  ).toMatchObject({ attempts: 2 });
});
test("definitive automatic failures stay bounded and manual cancellations suppress the canceled run", async () => {
  const rule = { id: "rule", maxAttempts: 2 };
  expect(await service.automaticJobs(rule, pipeline, [job()])).toHaveLength(1);
  await service.finishAutomatic(rule.id, pipeline, [job()], "FAILED");
  expect(await service.automaticJobs(rule, pipeline, [job()])).toHaveLength(1);
  await service.finishAutomatic(rule.id, pipeline, [job()], "FAILED");
  expect(await service.automaticJobs(rule, pipeline, [job()])).toHaveLength(0);
  await configure();
  await execute({ action: "CANCEL", jobs: [{ ...job(), status: "RUNNING" }] });
  expect(
    await service.automaticJobs({ id: "other", maxAttempts: 5 }, pipeline, [
      { ...job(), status: "CANCELED" },
    ]),
  ).toHaveLength(0);
  expect(
    await service.automaticJobs({ id: "other", maxAttempts: 5 }, pipeline, [
      {
        ...job("new"),
        status: "FAILED",
        createdAt: new Date(Date.now() + 1000).toISOString(),
        targetUrl: "https://ci.example/run/new",
      },
    ]),
  ).toHaveLength(1);
});
test("manual cancel suppression follows a replaced canceled status for the same provider run", async () => {
  await configure();
  await execute({ action: "CANCEL", jobs: [{ ...job(), status: "RUNNING" }] });
  expect(
    await service.automaticJobs({ id: "rule", maxAttempts: 2 }, pipeline, [
      {
        ...job("replacement"),
        status: "CANCELED",
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    ]),
  ).toHaveLength(0);
});
test("uncertain requests and stale durable claims cannot replay the same observed failure", async () => {
  await configure();
  const runner = vi
    .fn<typeof runScript>()
    .mockRejectedValue(new ScriptExecutionError("HTTP timed out", true, []));
  service = new ExternalPipelineActionsService(
    async () => prisma,
    new CredentialService({ prisma }),
    runner,
  );
  const result = await execute();
  expect(result.status).toBe("UNCERTAIN");
  expect((await execute()).id).toBe(result.id);
  expect(
    await service.automaticJobs({ id: "rule", maxAttempts: 2 }, pipeline, [
      job(),
    ]),
  ).toHaveLength(0);
  expect(runner).toHaveBeenCalledTimes(1);
  const newer = job("new");
  const first = await execute({ jobs: [newer] });
  await prisma.externalPipelineExecution.update({
    where: { id: first.id },
    data: {
      status: "RUNNING",
      externalStatus: "NOT_REQUESTED",
      startedAt: new Date(Date.now() - 91_000),
      completedAt: null,
    },
  });
  expect(await execute({ jobs: [newer] })).toMatchObject({
    id: first.id,
    status: "UNCERTAIN",
  });
  expect(runner).toHaveBeenCalledTimes(2);
});
test("pipeline-scoped rules follow only their known external lineage across pipeline replacements", async () => {
  const rule = { id: "rule", pipelineId: "94", maxAttempts: 2 };
  const replacement = { ...pipeline, id: "95" };
  expect(await service.ruleApplies(rule, replacement, [job()])).toBe(false);
  await service.automaticJobs(rule, pipeline, [job()]);
  await service.finishAutomatic(rule.id, pipeline, [job()], "ACCEPTED");
  expect(await service.ruleApplies(rule, replacement, [job("new")])).toBe(true);
  expect(
    await service.ruleApplies(rule, { ...replacement, sha: "different" }, [
      job("new"),
    ]),
  ).toBe(false);
  expect(
    await service.ruleApplies(rule, replacement, [
      { ...job("new"), kind: "NATIVE" },
    ]),
  ).toBe(false);
});
test("status union deduplicates native and bridge IDs, filters pipelines and keeps unavailable retry history", () => {
  const statuses = [
    { id: 100, pipeline_id: 94, name: "ci/test", status: "failed" },
    { id: 101, pipeline_id: 94, name: "ci/test", status: "success" },
    { id: 101, pipeline_id: 94, name: "ci/test", status: "success" },
    { id: 2, pipeline_id: 94, name: "bridge", status: "failed" },
    { id: 4, pipeline_id: 95, name: "other-pipeline", status: "running" },
    { id: 5, pipeline_id: 94, name: "unknown", status: "new_state" },
    { id: 6, pipeline_id: 94, name: "stopping", status: "canceling" },
  ];
  const jobs = combineExternalStatuses(
    pipeline,
    [{ ...job("1"), kind: "NATIVE" }],
    [{ ...job("2"), kind: "BRIDGE" }],
    statuses,
    { retry: true, cancel: true },
  );
  expect(jobs).toHaveLength(6);
  expect(jobs.find((job) => job.id === "100")).toMatchObject({
    retried: true,
    canRetry: false,
  });
  expect(jobs.find((job) => job.id === "101")).toMatchObject({
    kind: "EXTERNAL",
    canRetry: true,
    targetUrl: null,
    webUrl: pipeline.webUrl,
  });
  expect(jobs.find((job) => job.id === "5")).toMatchObject({
    status: "UNKNOWN",
    canRetry: false,
    canCancel: false,
  });
  expect(jobs.find((job) => job.id === "6")?.canCancel).toBe(false);
});
test("runtime limits asynchronous waits and loops, sanitizes output, rejects non-HTTP and has no host access", async () => {
  const options = {
    context: {},
    mode: "external" as const,
    memoryLimitMb: 32,
    timeoutMs: 100,
    fetchTimeoutMs: 50,
  };
  expect(
    (
      await runScript({
        ...options,
        source:
          "return [typeof process, typeof require, typeof storage, typeof Deno];",
      })
    ).result,
  ).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  for (const source of ["while(true) {}", "await new Promise(() => {});"])
    await expect(runScript({ ...options, source })).rejects.toThrow(
      "timed out",
    );
  await expect(
    runScript({ ...options, source: 'await fetch("file:///secret");' }),
  ).rejects.toThrow("HTTP and HTTPS");
  await expect(runScript({ ...options, source: "return (" })).rejects.toThrow(
    "Script failed",
  );
  await expect(
    runScript({ ...options, source: " ".repeat(100_001) + "return 1;" }),
  ).rejects.toThrow("100,000");
  const result = await runScript({
    ...options,
    timeoutMs: 1000,
    source:
      'for(let i=0;i<1000;i++) console.log("token", "x".repeat(1000)); return {token: "token"};',
    secrets: ["token"],
  });
  expect(result.console.length).toBeLessThanOrEqual(200);
  expect(
    result.console.reduce((sum, item) => sum + item.message.length, 0),
  ).toBeLessThanOrEqual(20_000);
  expect(JSON.stringify(result.result)).not.toContain('"token"');
});
