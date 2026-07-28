import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { JiraWebhooksPage } from "./webhooks-page";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneConnected: vi.fn(() => vi.fn()),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const delivery = {
  deliveryId: "delivery-1",
  event: "jira:issue_updated",
  issueKey: "AIDE-42",
  projectKey: "AIDE",
  changelog: {
    id: "10124",
    items: [
      {
        field: "status",
        fieldId: "status",
        fieldType: "jira",
        from: "10000",
        fromString: "To Do",
        to: "3",
        toString: "In Review",
      },
    ],
  },
  retryCount: 2,
  outcome: "ERROR",
  error: "Jira webhook payload is invalid JSON",
  receivedAt: "2026-07-26T16:00:00.000Z",
  processedAt: "2026-07-26T16:00:01.000Z",
};

beforeEach(() => {
  requestMock.mockReset();
  navigation.replace.mockReset();
  subscriptions.mockReturnValue({
    subscribe: vi.fn(() => vi.fn()),
  } as never);
});

afterEach(() => {
  cleanup();
});

describe("JiraWebhooksPage", () => {
  test("shows webhook deliveries in a paginated event table", async () => {
    requestMock.mockResolvedValue({
      jiraWebhookDeliveries: {
        enabled: true,
        items: [delivery],
        total: 51,
        limit: 50,
        offset: 0,
      },
    } as never);

    render(<JiraWebhooksPage />);

    expect(
      await screen.findByRole("heading", { name: "Jira Webhooks" }),
    ).toBeDefined();
    // The "jira:" prefix is noise once the page is already scoped to Jira.
    expect(screen.getByText("issue updated")).toBeDefined();
    expect(screen.getByText("AIDE-42")).toBeDefined();
    expect(screen.getByText("AIDE")).toBeDefined();
    expect(screen.getByText("1 change")).toBeDefined();
    expect(screen.getByText("status")).toBeDefined();
    expect(screen.getByText("To Do")).toBeDefined();
    expect(screen.getByText("In Review")).toBeDefined();
    expect(screen.getByText("Retry 2")).toBeDefined();
    expect(
      screen.getByText("Jira webhook payload is invalid JSON"),
    ).toBeDefined();
    expect(screen.getByText("delivery-1")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenLastCalledWith(
        expect.stringContaining("query JiraWebhooksPage"),
        { limit: 50, offset: 50 },
      );
    });
  });

  test("prepends a delivery pushed over the subscription", async () => {
    requestMock.mockResolvedValue({
      jiraWebhookDeliveries: {
        enabled: true,
        items: [delivery],
        total: 1,
        limit: 50,
        offset: 0,
      },
    } as never);
    let emit: ((value: unknown) => void) | null = null;
    subscriptions.mockReturnValue({
      subscribe: vi.fn(
        (_request: unknown, sink: { next: (v: unknown) => void }) => {
          emit = sink.next;
          return vi.fn();
        },
      ),
    } as never);

    render(<JiraWebhooksPage />);
    await screen.findByText("delivery-1");

    emit!({
      data: {
        jiraWebhookDeliveryChanged: {
          ...delivery,
          deliveryId: "delivery-2",
          issueKey: "AIDE-43",
          outcome: "PROCESSED",
          error: null,
        },
      },
    });

    expect(await screen.findByText("delivery-2")).toBeDefined();
    expect(screen.getByText("AIDE-43")).toBeDefined();
    // The page the user was already looking at stays put underneath it.
    expect(screen.getByText("delivery-1")).toBeDefined();
  });

  test("redirects without rendering deliveries when webhooks are disabled", async () => {
    requestMock.mockResolvedValue({
      jiraWebhookDeliveries: {
        enabled: false,
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      },
    } as never);

    render(<JiraWebhooksPage />);

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith("/");
    });
    expect(screen.queryByRole("heading", { name: "Jira Webhooks" })).toBeNull();
  });

  test("clears webhook delivery history after confirmation", async () => {
    let items = [delivery];
    requestMock.mockImplementation(async (query) => {
      if (query.includes("clearJiraWebhookDeliveries")) {
        items = [];
        return { clearJiraWebhookDeliveries: true } as never;
      }
      return {
        jiraWebhookDeliveries: {
          enabled: true,
          items,
          total: items.length,
          limit: 50,
          offset: 0,
        },
      } as never;
    });

    render(<JiraWebhooksPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Clear history" }),
    );

    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      requestMock.mock.calls.some(([query]) =>
        String(query).includes("clearJiraWebhookDeliveries"),
      ),
    ).toBe(false);

    fireEvent.click(
      await screen.findByRole("button", { name: "Clear history" }),
    );

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "mutation { clearJiraWebhookDeliveries }",
      );
      expect(screen.getByText("No webhook deliveries yet.")).toBeDefined();
    });
  });
});
