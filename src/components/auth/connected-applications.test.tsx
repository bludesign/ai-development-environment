import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
            firstAuthorizedAt: "2026-10-20T12:00:00Z",
            authorizationCount: 2,
          },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ disconnected: true }))
    .mockResolvedValueOnce(Response.json({ enabled: true, clients: [] }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ConnectedApplications />);
  expect(await screen.findByText("Example client")).toBeTruthy();
  expect(screen.getByText("Write")).toBeTruthy();
  expect(screen.getByText("mcp:write")).toBeTruthy();
  expect(screen.getByText("client-1")).toBeTruthy();
  expect(screen.getByText("2")).toBeTruthy();
  expect(
    [...view.container.querySelectorAll("time")].map((element) =>
      element.getAttribute("dateTime"),
    ),
  ).toEqual(["2026-10-20T12:00:00Z", "2026-10-27T12:00:00Z"]);
  expect(
    screen.getByText(/Renew access without another interactive sign-in/),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  let dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Disconnect Example client?")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(fetch).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
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
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(Response.json({ enabled: false, clients: [] }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ConnectedApplications />);
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.queryByText("Loading connected applications…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    await screen.findByText("You have no connected applications."),
  ).toBeTruthy();
  expect(
    screen.queryByText("The request could not be completed. Please try again."),
  ).toBeNull();
  expect(
    screen.getByText(/Existing OAuth tokens cannot access MCP/),
  ).toBeTruthy();
  const signal = fetch.mock.calls[1][1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});

test("explains read-only access and preserves a connection after a failed disconnect", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        enabled: true,
        clients: [
          {
            clientId: "chatgpt-client",
            name: "ChatGPT",
            scopes: ["mcp:read"],
            connectedAt: "2026-10-27T12:00:00Z",
            firstAuthorizedAt: "2026-10-27T12:00:00Z",
            authorizationCount: 1,
          },
        ],
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetch);
  render(<ConnectedApplications />);
  expect(await screen.findByText("ChatGPT")).toBeTruthy();
  expect(screen.getByText(/Offline access was not granted/)).toBeTruthy();
  expect(
    screen.getByText(
      /client must request write, destructive, or offline access/,
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Write")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByText("ChatGPT")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
