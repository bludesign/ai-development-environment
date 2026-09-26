import type { Page } from "@playwright/test";

import { jiraCachedTicketFixture } from "../scripts/mock-data/jira";

/** Keep the cache inspector on the seed even when another capture refreshes Jira. */
export async function stubJiraCacheTicket(page: Page): Promise<void> {
  await page.route("**/api/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      query?: string;
      variables?: { issueKey?: string };
    } | null;
    const ticket = jiraCachedTicketFixture();
    if (
      body?.query?.includes("query CachedJiraTicket(") &&
      body.variables?.issueKey === ticket.issueKey
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: { jiraCachedTicket: ticket } }),
      });
      return;
    }
    await route.continue();
  });
}
