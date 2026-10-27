import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectedApplications } from "./connected-applications";

afterEach(() => vi.unstubAllGlobals());

test("shows granted permissions and removes a client after disconnect", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        enabled: true,
        clients: [
          {
            clientId: "client-1",
            name: "Example client",
            scopes: ["mcp:read", "mcp:write", "offline_access"],
            connectedAt: "2026-10-27T12:00:00Z",
          },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ disconnected: true }))
    .mockResolvedValueOnce(Response.json({ enabled: true, clients: [] }));
  vi.stubGlobal("fetch", fetch);
  render(<ConnectedApplications />);
  expect(await screen.findByText("Example client")).toBeTruthy();
  expect(screen.getByText("Write")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(
    await screen.findByText("You have no connected applications."),
  ).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(
    "/api/auth/mcp-connections",
    expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ clientId: "client-1" }),
    }),
  );
});

test("shows load failures and cancels an abandoned request", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ConnectedApplications />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.queryByText("Loading connected applications…")).toBeNull();
  const signal = fetch.mock.calls[0][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
