import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
const consent = vi.hoisted(() => vi.fn());
vi.mock("@/services/auth/auth-client", () => ({
  authClient: { oauth2: { consent } },
}));
import { McpConsentForm } from "./mcp-consent-form";

beforeEach(() => {
  consent
    .mockReset()
    .mockResolvedValue({ error: { message: "Please try again" } });
});
function renderConsent(
  scopes = ["mcp:read", "mcp:write", "mcp:destructive", "offline_access"],
) {
  render(
    <McpConsentForm
      clientId="https://client.example/metadata.json"
      clientName="Example client"
      oauthQuery="signed-query"
      requestedScopes={scopes}
    />,
  );
}
test("defaults to read-only and sends an explicit partial grant", async () => {
  renderConsent();
  expect(screen.getByText("https://client.example/metadata.json")).toBeTruthy();
  for (const input of screen.getAllByRole("checkbox"))
    expect((input as HTMLInputElement).checked).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Allow selected permissions" }),
  );
  await waitFor(() =>
    expect(consent).toHaveBeenCalledWith({
      accept: true,
      scope: "mcp:read",
      oauth_query: "signed-query",
    }),
  );
});
test("requires explicit write, destructive, and offline selection", async () => {
  renderConsent();
  const [write, destructive, offline] = screen.getAllByRole("checkbox");
  expect((destructive as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(write);
  fireEvent.click(destructive);
  fireEvent.click(offline);
  fireEvent.click(
    screen.getByRole("button", { name: "Allow selected permissions" }),
  );
  await waitFor(() =>
    expect(consent).toHaveBeenCalledWith({
      accept: true,
      scope: "mcp:read mcp:write mcp:destructive offline_access",
      oauth_query: "signed-query",
    }),
  );
});
test("denies consent without implying a full grant", async () => {
  renderConsent(["mcp:read"]);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await waitFor(() =>
    expect(consent).toHaveBeenCalledWith({
      accept: false,
      scope: "mcp:read",
      oauth_query: "signed-query",
    }),
  );
});
