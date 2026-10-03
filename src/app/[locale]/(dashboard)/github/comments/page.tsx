import { CommentsPage } from "@/components/github/comments-page";

export default async function CommentsRoute({
  searchParams,
}: {
  searchParams: Promise<{ pullRequest?: string | string[] }>;
}) {
  const value = (await searchParams).pullRequest;
  return (
    <CommentsPage
      initialPullRequest={Array.isArray(value) ? (value[0] ?? null) : value}
    />
  );
}
