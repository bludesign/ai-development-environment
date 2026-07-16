import { JiraCacheTicketDetailPage } from "@/components/jira/cache-ticket-detail";

export default async function CachedTicketPage({
  params,
}: PageProps<"/[locale]/jira/cache/tickets/[issueKey]">) {
  const { issueKey } = await params;
  return <JiraCacheTicketDetailPage issueKey={decodeURIComponent(issueKey)} />;
}
