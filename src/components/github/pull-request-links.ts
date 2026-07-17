type PullRequestLinkTarget = {
  number: number;
  repositoryNameWithOwner: string;
};

export function pullRequestKey(pullRequest: PullRequestLinkTarget): string {
  return `${pullRequest.repositoryNameWithOwner}#${pullRequest.number}`;
}

export function pullRequestDetailHref(
  pullRequest: PullRequestLinkTarget,
): string {
  const [owner = "", repository = ""] =
    pullRequest.repositoryNameWithOwner.split("/");
  return `/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${pullRequest.number}`;
}

export function pullRequestCommentsHref(
  pullRequest: PullRequestLinkTarget,
): string {
  return `/comments?pullRequest=${encodeURIComponent(pullRequestKey(pullRequest))}`;
}
