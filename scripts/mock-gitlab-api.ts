import { gitlabMockData as data } from "./mock-data/gitlab";
import { paginateMockRecords } from "./mock-api-pagination";

/** Only serves the fixture instance; the screenshot preload keeps its public URLs intact. */
export function mockGitLabApi(path: string, search: URLSearchParams) {
  const project = `/projects/${data.projectId}`;
  const paged = (records: readonly unknown[]) => {
    const result = paginateMockRecords(records, search);
    return { payload: result.items, headers: result.headers, status: 200 };
  };
  const single = (payload: unknown) => ({ payload, headers: {}, status: 200 });
  if (path === `${project}/pipelines`) {
    const filtered = data.pipelines
      .filter(
        (pipeline) =>
          (!search.get("status") || pipeline.status === search.get("status")) &&
          (!search.get("ref") || pipeline.ref === search.get("ref")) &&
          (!search.get("source") || pipeline.source === search.get("source")) &&
          (!search.get("sha") || pipeline.sha === search.get("sha")),
      )
      .toSorted((left, right) => right.id - left.id);
    return paged(filtered);
  }
  const pipelineMatch = path.match(
    new RegExp(`^${project}/pipelines/(\\d+)(?:/(jobs|bridges))?$`),
  );
  if (pipelineMatch) {
    const pipeline = data.pipelines.find(
      (item) => item.id === Number(pipelineMatch[1]),
    );
    if (pipeline && !pipelineMatch[2]) return single(pipeline);
    if (pipelineMatch[2] === "bridges") return paged([]);
    if (pipelineMatch[2] === "jobs")
      return paged(
        data.pipelineJobs.filter(
          (job) => job.pipeline.id === Number(pipelineMatch[1]),
        ),
      );
  }
  if (path === "/merge_requests" || path === `${project}/merge_requests`) {
    return paged(
      data.mergeRequests.filter(
        (mr, index) =>
          (!search.get("state") ||
            search.get("state") === "all" ||
            mr.state === search.get("state")) &&
          (!search.get("created_after") ||
            mr.created_at >= search.get("created_after")!) &&
          (search.get("scope") !== "reviews_for_me" || index === 0),
      ),
    );
  }
  const mrMatch = path.match(
    new RegExp(
      `^${project}/merge_requests/(\\d+)(?:/(approvals|commits|discussions|pipelines))?$`,
    ),
  );
  if (mrMatch) {
    const index = data.mergeRequests.findIndex(
      (mr) => mr.iid === Number(mrMatch[1]),
    );
    const mr = data.mergeRequests[index];
    if (mr) {
      switch (mrMatch[2]) {
        case "approvals":
          return single({
            approvals_required: 1,
            approvals_left: index,
            approved_by: index ? [] : [{ user: data.user }],
          });
        case "commits":
          return paged(index === 0 ? data.mergeRequestCommits : []);
        case "discussions":
          return paged(index === 0 ? data.mergeRequestDiscussions : []);
        case "pipelines":
          return paged(
            data.pipelines.filter((pipeline) => pipeline.sha === mr.sha),
          );
        default:
          return single({
            ...mr,
            head_pipeline: data.pipelines.find(
              (pipeline) => pipeline.sha === mr.sha,
            ),
          });
      }
    }
  }
  if (path === project)
    return single({
      id: Number(data.projectId),
      name: "Platform",
      path_with_namespace: data.projectPath,
      web_url: `${data.baseUrl}/${data.projectPath}`,
      visibility: "private",
      merge_method: "merge",
      squash_option: "default_on",
    });
  if (path === "/user") return single(data.user);
  if (path === "/version")
    return single({ version: "19.2.0", revision: "mock-acme" });
  // Unknown optional reads may still use the exact seeded provider cache on 404.
  return {
    payload: { message: "Screenshot fixture endpoint was not found" },
    headers: {},
    status: 404,
  };
}
