import { describe, expect, test, vi } from "vitest";

import { createJiraToolGroup } from "./jira";

function administrationTools() {
  const jira = {
    updateProjectDisplaySettings: vi.fn(async () => []),
  };
  const webhooks = {
    rotateSecret: vi.fn(async () => ({
      secret: "new-webhook-secret",
      settings: {},
    })),
  };
  const group = createJiraToolGroup(jira as never, webhooks as never);
  return { jira, webhooks, tools: group.children[0]!.tools };
}

describe("Jira administration tools", () => {
  test.each(["ALL", "UNASSIGNED_OR_SELF", "SELF_IN_PROGRESS"] as const)(
    "accepts the Jira assignment filter %s",
    async (ticketAssignmentFilter) => {
      const { jira, tools } = administrationTools();
      const tool = tools.find(
        ({ name }) => name === "update_jira_project_display_settings",
      )!;
      const input = {
        projectId: "project-1",
        ticketAssignmentFilter,
        hideCompletedTickets: false,
        completedStatusIds: [],
      };

      await expect(tool.invoke(input)).resolves.toEqual({ projects: [] });
      expect(jira.updateProjectDisplaySettings).toHaveBeenCalledWith(input);
    },
  );

  test("returns a manually rotated secret exactly once to the caller", async () => {
    const { webhooks, tools } = administrationTools();
    const tool = tools.find(
      ({ name }) => name === "rotate_jira_webhook_secret",
    )!;

    await expect(tool.invoke({})).resolves.toEqual({
      rotated: true,
      secret: "new-webhook-secret",
    });
    expect(webhooks.rotateSecret).toHaveBeenCalledOnce();
  });
});
