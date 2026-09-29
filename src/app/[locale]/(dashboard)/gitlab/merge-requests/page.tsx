import { GitLabMergeRequestsPage } from "@/components/gitlab/pages";

export default async function GitLabMergeRequestsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) search.set(key, first);
  }
  return <GitLabMergeRequestsPage initialSearch={search.toString()} />;
}
