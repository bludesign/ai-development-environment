import { GitLabCommentsPage } from "@/components/gitlab/comments-page";

export default async function GitLabCommentsRoute({
  searchParams,
}: {
  searchParams: Promise<{
    project?: string | string[];
    iid?: string | string[];
    discussion?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const first = (value?: string | string[]) =>
    Array.isArray(value) ? value[0] : value;
  return (
    <GitLabCommentsPage
      initialProjectId={first(params.project)}
      initialIid={Number(first(params.iid)) || null}
      initialDiscussionId={first(params.discussion)}
    />
  );
}
