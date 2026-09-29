import { expect, type Page } from "@playwright/test";

import { ids } from "../scripts/mock-data/ids";
import { screenshotSessionToken } from "../scripts/mock-data/auth";

/**
 * Keep package selection, reference matching and conflicts on the real server. Only replace
 * the selected clone inspection, which would otherwise wait for absent mock agents. This
 * helper never calls apply/sync mutations, so parallel route captures cannot change fixtures.
 */
async function stubClonePreflight(page: Page) {
  await page.route("**/api/graphql", async (route) => {
    const body = route.request().postDataJSON() as {
      query?: string;
      variables?: {
        input?: {
          destinations?: Array<{
            repositoryKey: string;
            agentId: string;
            relativePath: string;
            remoteUrl: string;
          }>;
        };
      };
    };
    const input = body.variables?.input;
    if (
      !body.query?.includes("query PreviewRepositoryTransfer") ||
      !input?.destinations?.length
    ) {
      await route.fallback();
      return;
    }
    const response = await route.fetch({
      postData: JSON.stringify({
        ...body,
        variables: { ...body.variables, input: { ...input, destinations: [] } },
      }),
    });
    const result = await response.json();
    const preview = result.data?.previewRepositoryTransfer;
    if (preview) {
      const coverage = preview.destinations as Array<{
        repositoryKey: string;
        agentId: string;
        status: string;
      }>;
      for (const destination of input.destinations) {
        const index = coverage.findIndex(
          (entry) =>
            entry.repositoryKey === destination.repositoryKey &&
            entry.agentId === destination.agentId,
        );
        const existing = coverage[index];
        const inspected =
          existing?.status === "REUSE"
            ? { ...existing, ...destination }
            : {
                ...destination,
                repositoryId:
                  preview.items.find(
                    (item: { key: string }) =>
                      item.key === destination.repositoryKey,
                  )?.targetId ?? null,
                destinationPath: `/Users/acme/Repositories/${destination.relativePath}`,
                status: "READY",
                error: null,
              };
        if (index === -1) coverage.push(inspected);
        else coverage[index] = inspected;
      }
      preview.blockers = preview.blockers.filter(
        (blocker: string) =>
          blocker !== "Select at least one destination agent for this app",
      );
    }
    await route.fulfill({ response, json: result });
  });
}

export async function openRepositoryTransfer(
  page: Page,
  direction: "export" | "import" | "import-destinations",
) {
  if (direction === "export") {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Contents", exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Download JSON", exact: true }),
    ).toBeEnabled();
    return;
  }

  await stubClonePreflight(page);
  const response = await page.request.post(
    new URL("/api/graphql", page.url()).toString(),
    {
      headers: { Authorization: `Bearer ${screenshotSessionToken}` },
      data: {
        query:
          "query ScreenshotTransferPackage($input: RepositoryTransferExportInput!) { exportRepositoryTransfer(input: $input) }",
        variables: { input: { scope: "APP", id: ids.apps.customerPortal } },
      },
    },
  );
  const body = await response.json();
  expect(
    body.errors,
    "Screenshot transfer package must come from the real export service",
  ).toBeUndefined();
  const payload = body.data.exportRepositoryTransfer as {
    entities: Array<{
      kind: string;
      name: string;
      fields: Record<string, unknown>;
    }>;
  };
  const app = payload.entities.find((entity) => entity.kind === "APP")!;
  app.fields.description =
    "Customer portal with shared mobile sign-in and automated review workflows.";
  const repository = payload.entities.find(
    (entity) => entity.kind === "REPOSITORY" && entity.name === "web-app",
  )!;
  repository.fields.description =
    "Customer portal web application and account settings.";
  repository.fields.jiraBranchRegex = "(ACME-[0-9]+)";

  await page.getByRole("button", { name: "Import", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("JSON package", { exact: true }).setInputFiles({
    name: "customer-portal.aide.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(
    dialog.getByRole("heading", { name: "Destination agents", exact: true }),
  ).toBeVisible();
  // The React-generated editor prefix keeps repeated destination controls unique;
  // the stable suffix links the mock agent to its selection control.
  const selectedAgent =
    direction === "import-destinations" ? ids.agents.studio : ids.agents.build;
  await dialog.locator(`[id$="-transfer-agent-${selectedAgent}"]`).click();
  await dialog
    .getByRole("button", { name: "Review import", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Import selected", exact: true }),
  ).toBeEnabled();
  if (direction === "import-destinations") {
    const studio = dialog.getByRole("group", {
      name: "Studio Mac",
      exact: true,
    });
    await expect(
      studio.getByText("Already present", { exact: true }),
    ).toHaveCount(2);
    await expect(
      studio.getByText("/Users/acme/Repositories/web-app", { exact: true }),
    ).toBeVisible();
    await studio.evaluate((element) =>
      element.scrollIntoView({ behavior: "instant", block: "center" }),
    );
    return;
  }
  await dialog
    .getByRole("button", { name: "Review values", exact: true })
    .first()
    .click();
  await dialog.evaluate((element) => {
    element.scrollTop = 0;
  });
}
