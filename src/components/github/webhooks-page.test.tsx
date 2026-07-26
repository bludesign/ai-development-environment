import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { GitHubWebhooksPage } from "./webhooks-page";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

const delivery = {
  deliveryId: "delivery-1",
  event: "workflow_run",
  action: "completed",
  repositoryName: "acme/widgets",
  workflowRunId: "4242",
  outcome: "ERROR",
  error: "GitHub webhook payload is incomplete",
  receivedAt: "2026-07-26T16:00:00.000Z",
  processedAt: "2026-07-26T16:00:01.000Z",
};

beforeEach(() => {
  requestMock.mockReset();
  navigation.replace.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("GitHubWebhooksPage", () => {
  test("shows webhook deliveries in a paginated event table", async () => {
    requestMock.mockResolvedValue({
      githubWebhookDeliveries: {
        enabled: true,
        items: [delivery],
        total: 51,
        limit: 50,
        offset: 0,
      },
    } as never);

    render(<GitHubWebhooksPage />);

    expect(
      await screen.findByRole("heading", { name: "GitHub Webhooks" }),
    ).toBeDefined();
    expect(screen.getByText("workflow run")).toBeDefined();
    expect(screen.getByText("completed")).toBeDefined();
    expect(screen.getByText("acme/widgets")).toBeDefined();
    expect(screen.getByText("Workflow run 4242")).toBeDefined();
    expect(
      screen.getByText("GitHub webhook payload is incomplete"),
    ).toBeDefined();
    expect(screen.getByText("delivery-1")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenLastCalledWith(
        expect.stringContaining("query GitHubWebhooksPage"),
        { limit: 50, offset: 50 },
      );
    });
  });

  test("redirects without rendering deliveries when webhooks are disabled", async () => {
    requestMock.mockResolvedValue({
      githubWebhookDeliveries: {
        enabled: false,
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      },
    } as never);

    render(<GitHubWebhooksPage />);

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith("/");
    });
    expect(
      screen.queryByRole("heading", { name: "GitHub Webhooks" }),
    ).toBeNull();
  });

  test("clears webhook delivery history after confirmation", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("clearGitHubWebhookDeliveries")) {
        return { clearGitHubWebhookDeliveries: true } as never;
      }
      return {
        githubWebhookDeliveries: {
          enabled: true,
          items: [delivery],
          total: 1,
          limit: 50,
          offset: 0,
        },
      } as never;
    });

    render(<GitHubWebhooksPage />);

    const clearButton = await screen.findByRole("button", {
      name: "Clear history",
    });
    fireEvent.click(clearButton);

    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      requestMock.mock.calls.some(([query]) =>
        String(query).includes("clearGitHubWebhookDeliveries"),
      ),
    ).toBe(false);

    fireEvent.click(
      await screen.findByRole("button", { name: "Clear history" }),
    );

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        "mutation { clearGitHubWebhookDeliveries }",
      );
      expect(screen.getByText("No webhook deliveries yet.")).toBeDefined();
    });
  });
});
