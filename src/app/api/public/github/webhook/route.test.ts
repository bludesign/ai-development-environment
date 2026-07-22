import { beforeEach, describe, expect, test, vi } from "vitest";

const handleWebhook = vi.hoisted(() => vi.fn());

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({
    gitHubActionsNotificationsService: { handleWebhook },
  }),
}));

import { POST } from "./route";

beforeEach(() => {
  handleWebhook.mockReset();
});

describe("POST /api/public/github/webhook", () => {
  test("passes the exact body and GitHub headers to the webhook service", async () => {
    handleWebhook.mockResolvedValue({
      outcome: "PROCESSED",
      notificationCreated: true,
    });
    const body = JSON.stringify({ action: "completed" });

    const response = await POST(
      new Request("https://control.example/api/public/github/webhook", {
        method: "POST",
        headers: {
          "x-github-delivery": "delivery-1",
          "x-github-event": "workflow_run",
          "x-hub-signature-256": "sha256=signature",
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith({
      body: expect.any(Uint8Array),
      signature: "sha256=signature",
      event: "workflow_run",
      deliveryId: "delivery-1",
    });
    expect(Array.from(handleWebhook.mock.calls[0]![0].body)).toEqual(
      Array.from(new TextEncoder().encode(body)),
    );
  });

  test("rejects declared and streamed bodies larger than one MiB", async () => {
    const declared = await POST(
      new Request("https://control.example/api/public/github/webhook", {
        method: "POST",
        headers: { "content-length": String(1024 * 1024 + 1) },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);

    const streamed = await POST(
      new Request("https://control.example/api/public/github/webhook", {
        method: "POST",
        body: new Uint8Array(1024 * 1024 + 1),
      }),
    );
    expect(streamed.status).toBe(413);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  test.each([
    [new Error("GitHub webhook signature is invalid"), 401],
    [new Error("GitHub webhook is not configured"), 503],
    [new Error("GitHub webhook payload is incomplete"), 400],
  ])("maps service errors to a safe HTTP status", async (error, status) => {
    handleWebhook.mockRejectedValue(error);
    const response = await POST(
      new Request("https://control.example/api/public/github/webhook", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
