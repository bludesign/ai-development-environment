import { beforeEach, expect, test, vi } from "vitest";
import { JiraService } from "./jira.service";
import type { JiraTransition } from "./types";

const project = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ jiraProject: project }),
}));
beforeEach(() =>
  project.findUnique.mockResolvedValue({ defaultResolutionId: "fallback" }),
);

type Internals = {
  getClients(): Promise<unknown>;
  mutateTicket(
    key: string,
    operation: string,
    mutation: () => Promise<void>,
  ): Promise<unknown>;
};
function setup(defaultValue?: unknown) {
  const service = new JiraService();
  const internal = service as unknown as Internals;
  const doTransition = vi.fn().mockResolvedValue({});
  vi.spyOn(internal, "getClients").mockResolvedValue({
    cloud: { issues: { doTransition } },
  });
  vi.spyOn(internal, "mutateTicket").mockImplementation(
    async (_key, _operation, mutation) => {
      await mutation();
      return { key: "APP-1" };
    },
  );
  vi.spyOn(service, "ticketTransitions").mockResolvedValue([
    {
      id: "31",
      name: "Done",
      requiredFields: ["Resolution"],
      fields: [
        {
          id: "resolution",
          name: "Resolution",
          required: true,
          defaultValue,
          allowedValues: [
            { id: "declared", name: "Fixed" },
            { id: "fallback", name: "Done" },
          ],
        },
      ],
    } as JiraTransition,
  ]);
  return { service, doTransition };
}
test("submits a required Resolution with the transition, preferring Jira's declared default", async () => {
  const { service, doTransition } = setup({ id: "declared" });
  await service.transitionTicket("app-1", "31");
  expect(doTransition).toHaveBeenCalledWith({
    issueIdOrKey: "APP-1",
    transition: { id: "31" },
    fields: { resolution: { id: "declared" } },
  });
});
test("submits the configured project Resolution when Jira declares no default", async () => {
  const { service, doTransition } = setup();
  await service.transitionTicket("APP-1", "31");
  expect(doTransition).toHaveBeenCalledWith(
    expect.objectContaining({ fields: { resolution: { id: "fallback" } } }),
  );
});
test("rejects a project fallback excluded by the actual transition and explains how to resolve it", async () => {
  project.findUnique.mockResolvedValue({ defaultResolutionId: "removed" });
  const { service, doTransition } = setup();
  await expect(service.transitionTicket("APP-1", "31")).rejects.toThrow(
    "Configure a fallback Resolution in project APP settings",
  );
  expect(doTransition).not.toHaveBeenCalled();
});
