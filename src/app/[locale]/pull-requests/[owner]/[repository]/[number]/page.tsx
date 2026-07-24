import { PullRequestDetailPage } from "@/components/github/pull-request-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function PullRequestDetailRoute({
  params,
}: {
  params: Promise<{ owner: string; repository: string; number: string }>;
}) {
  const { owner, repository, number } = await params;
  const decodedOwner = decodeURIComponent(owner);
  const decodedRepository = decodeURIComponent(repository);
  const pullRequestNumber = Number(number);
  return (
    <div className="space-y-6">
      <PullRequestDetailPage
        number={pullRequestNumber}
        owner={decodedOwner}
        repository={decodedRepository}
      />
      <WorkflowResourcePanel
        resourceId={number}
        resourceKind="PULL_REQUEST"
        sessionData={{
          pr: { number: pullRequestNumber },
          repo: {
            displayOrigin: `github.com/${decodedOwner}/${decodedRepository}`,
          },
        }}
      />
    </div>
  );
}
