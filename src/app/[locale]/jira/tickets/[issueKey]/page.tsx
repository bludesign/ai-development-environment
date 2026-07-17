import { JiraTicketDetailPage } from "@/components/jira/ticket-detail-page";

export default async function JiraTicketDetailRoute({
  params,
}: {
  params: Promise<{ issueKey: string }>;
}) {
  const { issueKey } = await params;
  return <JiraTicketDetailPage issueKey={decodeURIComponent(issueKey)} />;
}
