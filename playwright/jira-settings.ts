import { expect, type Page } from "@playwright/test";

import type { JiraProjectView } from "../src/services/jira/types";

type SettingsInput = {
  projectId: string;
  inReviewStatusId: string | null;
};

/** Keep settings captures and saves inside the browser fixture, independent of the shared seed. */
export async function stubJiraProjectSettings(page: Page) {
  let projects: JiraProjectView[] = [];
  const saved: SettingsInput[] = [];
  await page.route("**/api/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      query?: string;
      variables?: { input?: SettingsInput };
    };
    const query = body.query ?? "";
    if (/query\s+JiraProjects\b/.test(query)) {
      const response = await route.fetch();
      const result = (await response.json()) as {
        data: { jiraProjects: JiraProjectView[] };
      };
      if (!projects.length) {
        projects = result.data.jiraProjects.map((project) => ({
          ...project,
          inReviewStatusId: "10004",
        }));
      }
      result.data.jiraProjects = projects;
      await route.fulfill({ response, json: result });
    } else if (/query\s+JiraProjectStatuses\b/.test(query)) {
      await route.fulfill({
        json: {
          data: {
            jiraProjectStatuses: [
              { id: "10000", name: "To Do", category: "new" },
              {
                id: "10001",
                name: "In Progress",
                category: "indeterminate",
              },
              { id: "10004", name: "In Review", category: "indeterminate" },
              { id: "10003", name: "Done", category: "done" },
            ],
            jiraResolutions: [{ id: "fixed", name: "Fixed" }],
          },
        },
      });
    } else if (/mutation\s+UpdateJiraProjectDisplaySettings\b/.test(query)) {
      const input = body.variables?.input;
      if (!input) throw new Error("Jira display settings input is required");
      saved.push(input);
      projects = projects.map((project) =>
        project.id === input.projectId
          ? { ...project, ...input, id: project.id }
          : project,
      );
      await route.fulfill({
        json: { data: { updateJiraProjectDisplaySettings: projects } },
      });
    } else {
      await route.fallback();
    }
  });
  return { saved };
}

export async function openJiraProjectSettings(
  page: Page,
  expectedStatus = "In Review",
) {
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Manage Jira projects and sources",
    exact: true,
  });
  const status = dialog.getByRole("combobox", {
    name: "In review ticket status",
    exact: true,
  });
  await expect(status).toBeEnabled();
  await expect(status).toHaveText(expectedStatus);
  await status.evaluate((element) =>
    element.scrollIntoView({ behavior: "instant", block: "center" }),
  );
  await expect(status).toBeInViewport({ ratio: 1 });
  return { dialog, status };
}
