import { RepositoryDetailPage } from "@/components/codebases/repository-detail-page";

export default async function RepositoryDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; repositoryId: string }>;
}) {
  const { repositoryId } = await params;
  return (
    <RepositoryDetailPage repositoryId={repositoryId} key={repositoryId} />
  );
}
