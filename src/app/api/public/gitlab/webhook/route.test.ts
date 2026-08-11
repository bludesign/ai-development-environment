import { beforeEach, describe, expect, test, vi } from "vitest";

const handleWebhook = vi.hoisted(() => vi.fn());

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ gitLabService: { handleWebhook } }),
}));

import { POST } from "./route";

beforeEach(() => {
  handleWebhook.mockReset();
});

describe("POST /api/public/gitlab/webhook", () => {
  test("passes the bounded exact body to the webhook service", async () => {
    handleWebhook.mockResolvedValue({ duplicate: false });
    const body = JSON.stringify({ object_kind: "push" });
    const response = await POST(
      new Request("https://control.example/api/public/gitlab/webhook", {
        method: "POST",
        headers: { "x-gitlab-token": "token" },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith({
      rawBody: body,
      headers: expect.any(Headers),
    });
  });

  test("rejects declared and streamed bodies larger than one MiB", async () => {
    const declared = await POST(
      new Request("https://control.example/api/public/gitlab/webhook", {
        method: "POST",
        headers: { "content-length": String(1024 * 1024 + 1) },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);

    const streamed = await POST(
      new Request("https://control.example/api/public/gitlab/webhook", {
        method: "POST",
        body: new Uint8Array(1024 * 1024 + 1),
      }),
    );
    expect(streamed.status).toBe(413);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
