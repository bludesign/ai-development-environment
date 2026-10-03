import { GitHubCacheEntryDetailPage } from "@/components/github/cache-entry-detail";

export default async function CachedEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <GitHubCacheEntryDetailPage id={decodeURIComponent(id)} />;
}
