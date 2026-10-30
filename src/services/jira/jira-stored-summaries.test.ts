import { expect, test, vi } from "vitest";
import { JiraService } from "./jira.service";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ jiraCachedTicket: { findMany } }),
}));

test("stored summaries batch local reads, prefer newer details, and skip corrupt or missing cache entries", async () => {
  const raw = (summary: string) =>
    JSON.stringify({
      key: "APP-1",
      fields: { summary, status: { name: "Done" } },
    });
  findMany.mockResolvedValue([
    {
      issueKey: "APP-1",
      summaryJson: raw("Old"),
      detailJson: raw("New"),
      summaryFetchedAt: new Date(1),
      detailFetchedAt: new Date(2),
    },
    {
      issueKey: "APP-2",
      summaryJson: "{broken",
      detailJson: null,
      summaryFetchedAt: new Date(),
      detailFetchedAt: null,
    },
    {
      issueKey: "APP-3",
      summaryJson: null,
      detailJson: null,
      summaryFetchedAt: null,
      detailFetchedAt: null,
    },
  ]);
  const instance = new JiraService();
  const summary = vi.spyOn(instance, "summary");
  const values = await instance.storedSummaries([
    "app-1",
    "APP-1",
    "APP-2",
    "APP-3",
    "APP-4",
  ]);
  expect(findMany).toHaveBeenCalledOnce();
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { issueKey: { in: ["APP-1", "APP-2", "APP-3", "APP-4"] } },
    }),
  );
  expect(values.size).toBe(1);
  expect(values.get("APP-1")).toMatchObject({ summary: "New", status: "Done" });
  expect(summary).not.toHaveBeenCalled();
});
