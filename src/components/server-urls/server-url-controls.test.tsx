import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { serverUrlFixture } from "../../../test/fixtures/server-urls";
import { EndpointUrls, ServerUrlSelect } from "./server-url-controls";
import { ServerUrlsSettingsCard } from "./server-urls-settings-card";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  request: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/browser-utils", () => ({ copyText: mocks.copy }));
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: mocks.request,
}));
vi.mock("@/hooks/use-server-url-settings", () => ({
  useServerUrlSettings: () => ({
    settings: { ...serverUrlFixture, simulatorDefaultServerUrlKind: "REMOTE" },
    error: null,
    refresh: mocks.refresh,
  }),
}));

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("copies each configured endpoint variant and links to centralized settings", async () => {
  mocks.copy.mockResolvedValue(undefined);
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <EndpointUrls path="/api/telemetry/console-logs" />
    </form>,
  );
  for (const [name, baseUrl] of [
    ["Local", serverUrlFixture.effectiveLocalBaseUrl],
    ["Remote", serverUrlFixture.effectiveRemoteBaseUrl],
    ["Proxy", serverUrlFixture.proxyBaseUrl],
  ]) {
    fireEvent.click(
      screen.getByRole("button", { name: `Copy ${name} endpoint URL` }),
    );
    await waitFor(() =>
      expect(mocks.copy).toHaveBeenLastCalledWith(
        `${baseUrl}/api/telemetry/console-logs`,
      ),
    );
  }
  expect(submit).not.toHaveBeenCalled();
  expect(
    screen
      .getByRole("link", { name: "Manage server URLs in Settings" })
      .getAttribute("href"),
  ).toContain("/system/settings#server-urls");
  expect(
    screen.getByText(
      `${serverUrlFixture.effectiveLocalBaseUrl}/api/telemetry/console-logs`,
    ).className,
  ).toContain("break-all");
});

test("supports keyboard selection with a name and URL and hides unconfigured Proxy", async () => {
  const change = vi.fn();
  render(
    <ServerUrlSelect
      settings={{ ...serverUrlFixture, proxyBaseUrl: null }}
      value="LOCAL"
      onValueChange={change}
    />,
  );
  const selector = screen.getByRole("combobox", { name: "Server URL" });
  selector.focus();
  fireEvent.keyDown(selector, { key: "ArrowDown" });
  const remote = await screen.findByRole("option", { name: /Remote/ });
  expect(remote.textContent).toContain(serverUrlFixture.effectiveRemoteBaseUrl);
  expect(screen.queryByRole("option", { name: /Proxy/ })).toBeNull();
  remote.focus();
  fireEvent.keyDown(remote, { key: "Enter" });
  await waitFor(() => expect(change).toHaveBeenCalledWith("REMOTE"));
});

test("saves shared overrides without resetting a configured simulator default", async () => {
  mocks.request.mockResolvedValue({});
  render(<ServerUrlsSettingsCard />);
  fireEvent.change(screen.getByLabelText("Proxy URL (optional)"), {
    target: { value: "https://new.ts.net/" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save server URLs" }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining("saveServerUrlSettings"),
      expect.objectContaining({
        input: {
          localBaseUrlOverride: null,
          remoteBaseUrlOverride: null,
          proxyBaseUrl: "https://new.ts.net/",
          defaultServerUrlKind: "LOCAL",
          simulatorDefaultServerUrlKind: "REMOTE",
        },
      }),
    ),
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
