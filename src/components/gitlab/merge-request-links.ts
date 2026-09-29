export function gitLabCommentsHref(
  mergeRequest: { projectId: string; iid: number },
  discussionId?: string | null,
) {
  const params = new URLSearchParams({
    project: mergeRequest.projectId,
    iid: String(mergeRequest.iid),
  });
  if (discussionId) params.set("discussion", discussionId);
  return `/gitlab/comments?${params}`;
}

export function gitLabMergeRequestKey(mergeRequest: {
  projectId: string;
  iid: number;
}) {
  return JSON.stringify([mergeRequest.projectId, mergeRequest.iid]);
}
