import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { JiraSettingsPage } from "./settings-page";
import { controlPlaneRequest } from "@/lib/control-plane-client";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })),
  onControlPlaneConnected: vi.fn(() => vi.fn()),
}));

const requestMock = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("JiraSettingsPage", () => {
  test("never renders the stored token and submits only a replacement", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query { jiraSettings")) {
        return {
          jiraSettings: {
            siteUrl: "https://example.atlassian.net",
            email: "user@example.com",
            tokenConfigured: true,
            cacheTtlSeconds: 300,
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      return {
        saveJiraSettings: {
          siteUrl: "https://example.atlassian.net",
          email: "user@example.com",
          tokenConfigured: true,
          cacheTtlSeconds: 300,
          updatedAt: new Date().toISOString(),
        },
      } as never;
    });

    render(<JiraSettingsPage />);

    expect(await screen.findByDisplayValue("user@example.com")).toBeDefined();
    const tokenInput = screen.getByLabelText(
      "Jira API token",
    ) as HTMLInputElement;
    expect(tokenInput.value).toBe("");
    expect(tokenInput.type).toBe("password");
    expect(
      screen.getByText(/copy only its https:\/\/\*\.atlassian\.net origin/),
    ).toBeDefined();
    const tokenLink = screen.getByRole("link", {
      name: /Create Jira API token/,
    });
    expect(tokenLink.getAttribute("href")).toBe(
      "https://id.atlassian.com/manage-profile/security/api-tokens",
    );
    expect(tokenLink.getAttribute("target")).toBe("_blank");

    fireEvent.change(tokenInput, { target: { value: "replacement-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveJiraSettings"),
        expect.objectContaining({
          input: expect.objectContaining({ apiToken: "replacement-token" }),
        }),
      );
    });
    expect(screen.queryByDisplayValue("replacement-token")).toBeNull();
  });

  test("requires confirmation before saving a changed Jira site", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query { jiraSettings")) {
        return {
          jiraSettings: {
            siteUrl: "https://old.atlassian.net",
            email: "user@example.com",
            tokenConfigured: true,
            cacheTtlSeconds: 300,
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      return {
        saveJiraSettings: {
          siteUrl: "https://new.atlassian.net",
          email: "user@example.com",
          tokenConfigured: true,
          cacheTtlSeconds: 300,
          updatedAt: new Date().toISOString(),
        },
      } as never;
    });

    render(<JiraSettingsPage />);
    const siteInput = (await screen.findByLabelText(
      "Jira Cloud site URL",
    )) as HTMLInputElement;
    fireEvent.change(siteInput, {
      target: { value: "https://new.atlassian.net" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(await screen.findByRole("alertdialog")).toBeDefined();
    expect(
      screen.getByText(
        "Changing the Jira site removes all saved Jira projects, sources, and cached data. Continue?",
      ),
    ).toBeDefined();
    expect(
      requestMock.mock.calls.some(([query]) =>
        String(query).includes("SaveJiraSettings"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveJiraSettings"),
        expect.objectContaining({
          input: expect.objectContaining({
            resetSite: true,
            siteUrl: "https://new.atlassian.net",
          }),
        }),
      ),
    );
  });

  describe("webhook card", () => {
    const settings = {
      siteUrl: "https://example.atlassian.net",
      email: "user@example.com",
      tokenConfigured: true,
      cacheTtlSeconds: 300,
      updatedAt: new Date(0).toISOString(),
    };

    function mockWebhook(webhook: Record<string, unknown>) {
      requestMock.mockImplementation(async (query) => {
        if (query.includes("query { jiraSettings")) {
          return { jiraSettings: settings } as never;
        }
        if (query.includes("query { jiraWebhookSettings")) {
          return { jiraWebhookSettings: webhook } as never;
        }
        if (query.includes("enableJiraWebhook")) {
          return {
            enableJiraWebhook: {
              secret: "generated-secret",
              settings: { ...webhook, enabled: true, secretConfigured: true },
            },
          } as never;
        }
        if (query.includes("disableJiraWebhook")) {
          return {
            disableJiraWebhook: {
              ...webhook,
              enabled: false,
              secretConfigured: false,
            },
          } as never;
        }
        return {} as never;
      });
    }

    const unconfigured = {
      enabled: false,
      secretConfigured: false,
      configuredAt: null,
      lastReceivedAt: null,
      lastOutcome: null,
      lastError: null,
    };

    test("offers the copyable URL and generates a secret shown once", async () => {
      mockWebhook(unconfigured);

      render(<JiraSettingsPage />);

      expect(
        await screen.findByDisplayValue(
          "http://localhost:3000/api/public/jira/webhook",
        ),
      ).toBeDefined();
      expect(screen.getByText("Webhook not configured")).toBeDefined();
      // Nothing to reveal until the user asks for a secret.
      expect(screen.queryByDisplayValue("generated-secret")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Generate secret" }));

      expect(await screen.findByDisplayValue("generated-secret")).toBeDefined();
      expect(screen.getByText("Webhook configured")).toBeDefined();
      expect(screen.getByText("Jira webhook secret generated.")).toBeDefined();
    });

    test("shows the last delivery and links to the delivery log", async () => {
      mockWebhook({
        enabled: true,
        secretConfigured: true,
        configuredAt: "2026-07-26T12:00:00.000Z",
        lastReceivedAt: "2026-07-26T16:00:00.000Z",
        lastOutcome: "ERROR",
        lastError: "Jira webhook signature is invalid",
      });

      render(<JiraSettingsPage />);

      expect(
        await screen.findByRole("link", { name: "View deliveries" }),
      ).toBeDefined();
      expect(
        screen.getByText("Jira webhook signature is invalid"),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "Rotate secret" }),
      ).toBeDefined();
    });

    test("disables the webhook after confirmation", async () => {
      mockWebhook({
        enabled: true,
        secretConfigured: true,
        configuredAt: "2026-07-26T12:00:00.000Z",
        lastReceivedAt: null,
        lastOutcome: null,
        lastError: null,
      });

      render(<JiraSettingsPage />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Disable webhook" }),
      );
      expect(await screen.findByRole("alertdialog")).toBeDefined();
      expect(
        requestMock.mock.calls.some(([query]) =>
          String(query).includes("disableJiraWebhook"),
        ),
      ).toBe(false);

      fireEvent.click(
        await screen.findByRole("button", { name: "Disable webhook" }),
      );

      await waitFor(() => {
        expect(screen.getByText("Jira webhook disabled.")).toBeDefined();
        expect(screen.getByText("Webhook not configured")).toBeDefined();
      });
    });

    test("stays hidden until Jira credentials are configured", async () => {
      requestMock.mockImplementation(async (query) => {
        if (query.includes("query { jiraSettings")) {
          return {
            jiraSettings: { ...settings, tokenConfigured: false },
          } as never;
        }
        return {} as never;
      });

      render(<JiraSettingsPage />);

      await screen.findByLabelText("Jira API token");
      expect(screen.queryByText("Jira webhook")).toBeNull();
    });
  });
});
