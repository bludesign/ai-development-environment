import { beforeEach, describe, expect, test, vi } from "vitest";

import { JiraWebhookRequestError } from "@/services/jira";

const handleWebhook = vi.hoisted(() => vi.fn());

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ jiraWebhookService: { handleWebhook } }),
}));

import { POST } from "./route";

beforeEach(() => {
  handleWebhook.mockReset();
});

describe("POST /api/public/jira/webhook", () => {
  test("passes the exact body and Atlassian headers to the webhook service", async () => {
    handleWebhook.mockResolvedValue({
      outcome: "PROCESSED",
      event: "jira:issue_updated",
      issueKey: "AIDE-1",
      triggersRecorded: 0,
    });
    const body = JSON.stringify({ webhookEvent: "jira:issue_updated" });

    const response = await POST(
      new Request("https://control.example/api/public/jira/webhook", {
        method: "POST",
        headers: {
          "x-atlassian-webhook-identifier": "delivery-1",
          "x-atlassian-webhook-retry": "2",
          "x-hub-signature": "sha256=signature",
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith({
      body: expect.any(Uint8Array),
      signature: "sha256=signature",
      deliveryId: "delivery-1",
      retryCount: "2",
    });
    // The HMAC is computed over the raw bytes, so they have to survive intact.
    expect(Array.from(handleWebhook.mock.calls[0]![0].body)).toEqual(
      Array.from(new TextEncoder().encode(body)),
    );
  });

  test("answers 202 for deliveries that were not processed", async () => {
    handleWebhook.mockResolvedValue({
      outcome: "DUPLICATE",
      event: null,
      issueKey: null,
      triggersRecorded: 0,
    });

    const response = await POST(
      new Request("https://control.example/api/public/jira/webhook", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(202);
  });

  test("rejects declared and streamed bodies larger than one MiB", async () => {
    const declared = await POST(
      new Request("https://control.example/api/public/jira/webhook", {
        method: "POST",
        headers: { "content-length": String(1024 * 1024 + 1) },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);

    const streamed = await POST(
      new Request("https://control.example/api/public/jira/webhook", {
        method: "POST",
        body: new Uint8Array(1024 * 1024 + 1),
      }),
    );
    expect(streamed.status).toBe(413);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  test.each([
    [
      new JiraWebhookRequestError("Jira webhook signature is invalid", 401),
      401,
    ],
    [new JiraWebhookRequestError("Jira webhook is not configured", 503), 503],
    [
      new JiraWebhookRequestError("Jira webhook payload is invalid JSON", 400),
      400,
    ],
  ])("maps request errors to a safe HTTP status", async (error, status) => {
    handleWebhook.mockRejectedValue(error);
    const response = await POST(
      new Request("https://control.example/api/public/jira/webhook", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("returns a retryable status for operational processing failures", async () => {
    handleWebhook.mockRejectedValue(new Error("database unavailable"));

    const response = await POST(
      new Request("https://control.example/api/public/jira/webhook", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Jira webhook processing failed",
    });
  });
});
