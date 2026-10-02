import { afterEach, expect, test, vi } from "vitest";
import { GitLabService } from "./gitlab.service";
import { externalPipelineActionsService } from "./external-pipeline-actions";
import type { GitLabJobView, GitLabPipelineView } from "./types";

const pipeline: GitLabPipelineView = {
  id: "94",
  projectId: "21",
  iid: "1",
  sha: "original",
  ref: "main",
  branch: "main",
  source: "push",
  status: "FAILED",
  webUrl: "https://gitlab.example/pipelines/94",
  mergeRequests: [],
  worktreeId: null,
  worktreeHighlightColor: null,
  createdAt: null,
  updatedAt: null,
  startedAt: null,
  finishedAt: null,
  duration: null,
  queuedDuration: null,
};
function job(
  id: string,
  kind: "NATIVE" | "EXTERNAL",
  status: GitLabJobView["status"],
): GitLabJobView {
  return {
    id,
    pipelineId: pipeline.id,
    kind,
    status,
    name: id,
    stage: "test",
    ref: "main",
    webUrl: "https://ci.example/" + id,
    targetUrl: kind === "EXTERNAL" ? "https://ci.example/" + id : null,
    author: null,
    retried: false,
    allowFailure: false,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
    duration: null,
    queuedDuration: null,
  };
}
function setup(jobs: GitLabJobView[]) {
  const service = new GitLabService();
  const read = vi.spyOn(service, "pipeline").mockResolvedValue(pipeline);
  vi.spyOn(service, "pipelineJobs").mockResolvedValue(jobs);
  const native = vi
    .spyOn(
      service as unknown as {
        nativePipelineAction(...args: unknown[]): Promise<GitLabPipelineView>;
      },
      "nativePipelineAction",
    )
    .mockResolvedValue(pipeline);
  vi.spyOn(
    service as unknown as { connection(): Promise<{ baseUrl: string }> },
    "connection",
  ).mockResolvedValue({ baseUrl: "https://gitlab.example" });
  const external = vi
    .spyOn(externalPipelineActionsService, "execute")
    .mockImplementation(async (input) => {
      await input.native?.();
      return {
        id: "execution",
        status: "ACCEPTED",
        externalStatus: "ACCEPTED",
        nativeStatus: input.native ? "ACCEPTED" : "NOT_REQUESTED",
      } as Awaited<ReturnType<typeof externalPipelineActionsService.execute>>;
    });
  return { service, read, native, external };
}
afterEach(() => vi.restoreAllMocks());

test("mixed retry sends failed native work and invokes the script once for all eligible external jobs", async () => {
  const { service, read, native, external } = setup([
    job("native-ok", "NATIVE", "SUCCESS"),
    job("native-failed", "NATIVE", "FAILED"),
    job("external-ok", "EXTERNAL", "SUCCESS"),
    job("external-failed", "EXTERNAL", "FAILED"),
  ]);
  expect(
    (await service.dispatchPipelineAction("21", "94", "RETRY", "MCP")).execution
      ?.status,
  ).toBe("ACCEPTED");
  expect(read.mock.calls[0]).toEqual(["21", "94", true]);
  expect(native).toHaveBeenCalledExactlyOnceWith("21", "94", "RETRY");
  expect(external).toHaveBeenCalledTimes(1);
  expect(external.mock.calls[0][0]).toMatchObject({
    origin: "MCP",
    jobs: [{ id: "external-ok" }, { id: "external-failed" }],
    pipeline: { sha: "original" },
  });
});
test("successful external work retries without rerunning successful native work", async () => {
  const { service, native, external } = setup([
    job("native-ok", "NATIVE", "SUCCESS"),
    job("external-ok", "EXTERNAL", "SUCCESS"),
  ]);
  await service.dispatchPipelineAction("21", "94", "RETRY");
  expect(native).not.toHaveBeenCalled();
  expect(external.mock.calls[0][0].native).toBeUndefined();
});
test("native-only pipelines retain the native GitLab request", async () => {
  const { service, native, external } = setup([
    job("native-failed", "NATIVE", "FAILED"),
  ]);
  expect(
    (await service.dispatchPipelineAction("21", "94", "RETRY")).execution,
  ).toBeNull();
  expect(native).toHaveBeenCalledExactlyOnceWith("21", "94", "RETRY");
  expect(external).not.toHaveBeenCalled();
});
test("individual external actions exclude native work and revalidate superseded statuses", async () => {
  const jobs = [
    job("native", "NATIVE", "FAILED"),
    job("external", "EXTERNAL", "FAILED"),
  ];
  const { service, native, external } = setup(jobs);
  await service.dispatchPipelineAction(
    "21",
    "94",
    "RETRY",
    "MANUAL",
    "external",
  );
  expect(external.mock.calls[0][0].selectedJob?.id).toBe("external");
  expect(native).not.toHaveBeenCalled();
  jobs[1].retried = true;
  await expect(
    service.dispatchPipelineAction("21", "94", "RETRY", "MANUAL", "external"),
  ).rejects.toThrow("no longer eligible");
  expect(external).toHaveBeenCalledTimes(1);
});
test("mixed cancel targets active external work while excluding already-canceling work", async () => {
  const { service, native, external } = setup([
    job("native", "NATIVE", "PENDING"),
    job("external", "EXTERNAL", "RUNNING"),
    job("stopping", "EXTERNAL", "CANCELING"),
  ]);
  await service.dispatchPipelineAction("21", "94", "CANCEL", "WORKFLOW");
  expect(native).toHaveBeenCalledExactlyOnceWith("21", "94", "CANCEL");
  expect(external.mock.calls[0][0]).toMatchObject({
    origin: "WORKFLOW",
    jobs: [{ id: "external" }],
  });
});
test("configuration preflight failures stop a combined action before native requests", async () => {
  const { service, native, external } = setup([
    job("native", "NATIVE", "FAILED"),
    job("external", "EXTERNAL", "FAILED"),
  ]);
  external.mockRejectedValue(new Error("Configure the retry script"));
  await expect(
    service.dispatchPipelineAction("21", "94", "RETRY"),
  ).rejects.toThrow("Configure");
  expect(native).not.toHaveBeenCalled();
});
