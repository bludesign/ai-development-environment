import { GitLabMergeRequestDetailPage } from "@/components/gitlab/pages";

export default async function GitLabMergeRequestRoute({
  params,
}: {
  params: Promise<{ projectId: string; iid: string }>;
}) {
  const { projectId, iid } = await params;
  return (
    <GitLabMergeRequestDetailPage iid={Number(iid)} projectId={projectId} />
  );
}
