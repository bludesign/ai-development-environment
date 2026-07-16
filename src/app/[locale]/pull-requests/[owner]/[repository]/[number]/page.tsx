import { PullRequestDetailPage } from "@/components/github/pull-request-detail-page";

export default async function PullRequestDetailRoute({
  params,
}: {
  params: Promise<{ owner: string; repository: string; number: string }>;
}) {
  const { owner, repository, number } = await params;
  return (
    <PullRequestDetailPage
      number={Number(number)}
      owner={decodeURIComponent(owner)}
      repository={decodeURIComponent(repository)}
    />
  );
}
