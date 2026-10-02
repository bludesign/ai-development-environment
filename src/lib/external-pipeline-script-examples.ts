export type ExternalPipelineScriptAction = "retry" | "cancel";
export type ExternalPipelineScriptExample = "context" | "http";

export function externalPipelineScriptExample(
  action: ExternalPipelineScriptAction,
  example: ExternalPipelineScriptExample,
): string {
  const name = `${action}ExternalPipeline`;
  if (example === "context") {
    return `// Preview the injected context without making HTTP requests.
// Provider statuses stay unchanged. Secret values are never logged.
async function ${name}({
  version, action, origin, repository, gitlab, project, pipeline,
  externalJobs, job, mergeRequest, mergeRequests, secrets
}) {
  const result = {
    dryRun: true,
    version, action, origin, repository, gitlab, project, pipeline,
    externalJobs, job, mergeRequest, mergeRequests,
    secretNames: Object.keys(secrets)
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// The app injects context; call your function explicitly with it.
return await ${name}(context);`;
  }
  return `// Adapt this request to your CI provider or integration endpoint.
// Configure ACTION_BASE_URL and API_TOKEN as repository secrets first.
async function ${name}({
  action, repository, project, pipeline, externalJobs, job,
  mergeRequest, secrets
}) {
  if (!secrets.ACTION_BASE_URL || !secrets.API_TOKEN) {
    throw new Error("Configure ACTION_BASE_URL and API_TOKEN secrets first");
  }
  const runUrls = [...new Set(externalJobs.map(status => status.targetUrl))];
  if (runUrls.some(url => !url)) {
    throw new Error("Resolve missing run URLs with your provider API first");
  }
  const endpoint = secrets.ACTION_BASE_URL.replace(/\\/+$/, "") + "/" + action;
  for (const runUrl of runUrls) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secrets.API_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        runUrl,
        repository: repository.canonicalOrigin,
        projectId: project.id,
        sha: pipeline.sha,
        branch: pipeline.resolvedBranch,
        mergeRequest,
        jobId: job?.id ?? null
      })
    });
    if (!response.ok) throw new Error("Provider HTTP " + response.status);
  }
  return { requested: runUrls.length };
}

// The app injects context; call your function explicitly with it.
return await ${name}(context);`;
}

// Illustrative only: the execution supplies the real values for the selected action.
export const externalPipelineExampleContext = {
  version: 1,
  action: "retry",
  origin: "manual",
  repository: {
    id: "repository-id",
    name: "example-repo",
    canonicalOrigin: "gitlab.example.com/team/example-repo",
  },
  gitlab: { baseUrl: "https://gitlab.example.com" },
  project: {
    id: "21",
    name: "example-repo",
    pathWithNamespace: "team/example-repo",
    webUrl: "https://gitlab.example.com/team/example-repo",
  },
  pipeline: {
    id: "94",
    sha: "abc123",
    rawRef: "refs/merge-requests/2/head",
    ref: "refs/merge-requests/2/head",
    branch: "feature/tests",
    resolvedBranch: "feature/tests",
    source: "merge_request_event",
    status: "FAILED",
    webUrl: "https://gitlab.example.com/team/example-repo/-/pipelines/94",
  },
  externalJobs: [
    {
      id: "100",
      pipelineId: "94",
      kind: "EXTERNAL",
      name: "ci/tests",
      status: "FAILED",
      author: null,
      targetUrl: "https://ci.example.com/runs/123",
      retried: false,
    },
  ],
  job: null,
  mergeRequest: {
    projectId: "21",
    iid: 2,
    title: "Test changes",
    sourceBranch: "feature/tests",
    targetBranch: "main",
    sourceProjectId: "21",
    targetProjectId: "21",
    webUrl: "https://gitlab.example.com/team/example-repo/-/merge_requests/2",
  },
  mergeRequests: [
    {
      projectId: "21",
      iid: 2,
      title: "Test changes",
      sourceBranch: "feature/tests",
      targetBranch: "main",
      sourceProjectId: "21",
      targetProjectId: "21",
      webUrl: "https://gitlab.example.com/team/example-repo/-/merge_requests/2",
    },
  ],
  secrets: { API_TOKEN: "<configured repository secret>" },
};

export const externalPipelineContextFields = [
  ["version", "fieldVersion"],
  ["action, origin", "fieldAction"],
  ["repository", "fieldRepository"],
  ["gitlab, project", "fieldProject"],
  ["pipeline", "fieldPipeline"],
  ["externalJobs", "fieldExternalJobs"],
  ["job", "fieldJob"],
  ["mergeRequest, mergeRequests", "fieldMergeRequests"],
  ["secrets", "fieldSecrets"],
] as const;
