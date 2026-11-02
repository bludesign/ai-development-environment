import { beforeEach, expect, test, vi } from "vitest";
import { JiraService } from "./jira.service";
import type { JiraTicketDetail, JiraTransition } from "./types";

const project = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ jiraProject: project }),
}));

beforeEach(() => {
  vi.restoreAllMocks();
  project.findUnique.mockResolvedValue({ inReviewStatusId: "review" });
});

function setup(statusId = "doing") {
  const service = new JiraService();
  const ticket = { key: "APP-1", statusId } as JiraTicketDetail;
  const loadTicket = vi.spyOn(service, "ticket").mockResolvedValue(ticket);
  const transitions = vi
    .spyOn(service, "ticketTransitions")
    .mockResolvedValue([]);
  const transition = vi
    .spyOn(service, "transitionTicket")
    .mockResolvedValue(ticket);
  return { service, ticket, loadTicket, transitions, transition };
}

test.each([null, { inReviewStatusId: null }])(
  "does not contact Jira when no in review status is configured: %s",
  async (value) => {
    project.findUnique.mockResolvedValue(value);
    const { service, loadTicket } = setup();
    await expect(
      service.transitionTicketToConfiguredInReview("app-1"),
    ).resolves.toBeNull();
    expect(loadTicket).not.toHaveBeenCalled();
  },
);

test("returns the ticket without repeating a transition when already in review", async () => {
  const { service, ticket, transitions, transition } = setup("review");
  await expect(
    service.transitionTicketToConfiguredInReview("app-1"),
  ).resolves.toBe(ticket);
  expect(project.findUnique).toHaveBeenCalledWith({
    where: { key: "APP" },
    select: { inReviewStatusId: true },
  });
  expect(transitions).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
});

test("chooses an available target transition with the fewest unresolved fields and uses normal transition defaults", async () => {
  const { service, transitions, transition } = setup();
  transitions.mockResolvedValue([
    { id: "unrelated", toStatusId: "done", requiredFields: [] },
    {
      id: "manual",
      toStatusId: "review",
      requiredFields: ["Comment"],
      unresolvedRequiredFields: ["Comment"],
    },
    {
      id: "defaults",
      toStatusId: "review",
      requiredFields: ["Resolution"],
      unresolvedRequiredFields: [],
    },
  ] as JiraTransition[]);
  await service.transitionTicketToConfiguredInReview("app-1");
  expect(transition).toHaveBeenCalledWith("APP-1", "defaults");
});

test("gives an actionable error when the configured status cannot be reached", async () => {
  const { service, transition } = setup();
  await expect(
    service.transitionTicketToConfiguredInReview("APP-1"),
  ).rejects.toThrow("Open the ticket to update its status");
  expect(transition).not.toHaveBeenCalled();
});

test("preserves required-field errors from Jira transitions", async () => {
  const { service, transitions, transition } = setup();
  transitions.mockResolvedValue([
    { id: "review", toStatusId: "review", requiredFields: [] },
  ] as unknown as JiraTransition[]);
  transition.mockRejectedValue(new Error("Complete required field: Comment"));
  await expect(
    service.transitionTicketToConfiguredInReview("APP-1"),
  ).rejects.toThrow("Complete required field: Comment");
});
