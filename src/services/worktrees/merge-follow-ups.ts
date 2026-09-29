import type { JiraService } from "@/services/jira";

export function validateMergeFollowUps(
  input: { deleteWorktree?: boolean | null; moveTicketToDone?: boolean | null },
  options: {
    canDeleteWorktree: boolean;
    ticketKey: string | null;
    ticketDoneStatusConfigured: boolean;
  },
  requestName = "pull request",
): void {
  if (input.deleteWorktree && !options.canDeleteWorktree) {
    throw new Error(
      "Only a linked, non-primary worktree can be deleted after merge",
    );
  }
  if (
    input.moveTicketToDone &&
    (!options.ticketKey || !options.ticketDoneStatusConfigured)
  ) {
    throw new Error(
      options.ticketKey
        ? "Configure this Jira project's done status before enabling this option"
        : `This ${requestName} is not linked to a Jira ticket`,
    );
  }
}

/** Jira treats an already-completed transition as success, making crash recovery safe. */
export async function completeMergeTicketFollowUp(
  jira: JiraService,
  rule: {
    moveTicketToDone: boolean;
    ticketKey: string | null;
    ticketMovedAt: Date | null;
  },
): Promise<Date | null> {
  if (!rule.moveTicketToDone || !rule.ticketKey || rule.ticketMovedAt)
    return rule.ticketMovedAt;
  await jira.transitionTicketToConfiguredDone(rule.ticketKey);
  return new Date();
}
