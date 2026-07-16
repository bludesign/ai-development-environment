import { JiraCacheTicketDetailPage } from "@/components/jira/cache-ticket-detail";

export default async function CachedTicketPage({
  params,
}: {
  params: Promise<{ issueKey: string }>;
}) {
  const { issueKey } = await params;
  return <JiraCacheTicketDetailPage issueKey={decodeURIComponent(issueKey)} />;
}
