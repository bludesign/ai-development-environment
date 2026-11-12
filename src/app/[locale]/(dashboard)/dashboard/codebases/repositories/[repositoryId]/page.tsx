import { RepositoryDetailPage } from "@/components/codebases/repository-detail-page";

export default async function RepositoryDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; repositoryId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ repositoryId }, { tab }] = await Promise.all([params, searchParams]);
  const initialTab = tab === "android-app" ? "android-app" : "details";
  return (
    <RepositoryDetailPage
      initialTab={initialTab}
      repositoryId={repositoryId}
      key={`${repositoryId}:${initialTab}`}
    />
  );
}
