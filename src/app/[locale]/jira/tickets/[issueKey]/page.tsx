import { JiraTicketDetailPage } from "@/components/jira/ticket-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function JiraTicketDetailRoute({
  params,
}: {
  params: Promise<{ issueKey: string }>;
}) {
  const { issueKey } = await params;
  const decoded = decodeURIComponent(issueKey);
  return (
    <div className="space-y-6">
      <JiraTicketDetailPage issueKey={decoded} />
      <WorkflowResourcePanel
        resourceId={decoded}
        resourceKind="JIRA_TICKET"
        sessionData={{ ticket: { key: decoded } }}
      />
    </div>
  );
}
