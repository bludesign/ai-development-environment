import { serverUrlFixture } from "../../../test/fixtures/server-urls";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { AgentsList } from "./agents-list";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);
const subscriptionsMock = vi.mocked(controlPlaneSubscriptions);

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  subscriptionsMock.mockReset();
});

describe("AgentsList", () => {
  test("switches enrollment commands between shared Local, Remote, and Proxy", async () => {
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    requestMock.mockImplementation(async (operation) => {
      if (operation.includes("createAgentEnrollmentToken")) {
        return {
          createAgentEnrollmentToken: {
            token: "enroll-once",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        } as never;
      }
      if (operation.includes("query Agents")) return { agents: [] } as never;
      throw new Error(`Unexpected operation: ${operation}`);
    });

    render(<AgentsList localServerOrigins={["http://192.168.1.24:3000"]} />);
    await screen.findByText("No agents enrolled");
    fireEvent.click(screen.getByRole("button", { name: "Enroll agent" }));

    const code = await screen.findByText(/enroll-once/);
    expect(code.textContent).toContain(
      `--server '${serverUrlFixture.effectiveLocalBaseUrl}'`,
    );
    for (const [name, url] of [
      ["Remote", serverUrlFixture.effectiveRemoteBaseUrl],
      ["Proxy", serverUrlFixture.proxyBaseUrl],
    ] as const) {
      fireEvent.pointerDown(
        screen.getByRole("combobox", { name: "Server URL" }),
        { button: 0, ctrlKey: false, pointerType: "mouse" },
      );
      fireEvent.click(
        await screen.findByRole("option", { name: new RegExp(name) }),
      );
      await waitFor(() =>
        expect(code.textContent).toContain(`--server '${url}'`),
      );
    }
    expect(screen.queryByLabelText("Custom server address")).toBeNull();
    await waitFor(() =>
      expect(
        screen.getAllByRole("link", { name: "Manage server URLs in Settings" })
          .length,
      ).toBeGreaterThan(0),
    );
  });

  test("adds shell-safe transient headers only to the enrollment command", async () => {
    subscriptionsMock.mockReturnValue({
      subscribe: vi.fn(() => vi.fn()),
    } as never);
    requestMock.mockImplementation(async (operation) => {
      if (operation.includes("createAgentEnrollmentToken")) {
        return {
          createAgentEnrollmentToken: {
            token: "enroll-once",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        } as never;
      }
      if (operation.includes("query Agents")) return { agents: [] } as never;
      throw new Error(`Unexpected operation: ${operation}`);
    });

    render(<AgentsList />);
    await screen.findByText("No agents enrolled");
    fireEvent.click(screen.getByRole("button", { name: "Enroll agent" }));
    await screen.findByText(/enroll-once/);
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    const headerName = screen.getByLabelText<HTMLInputElement>("Header key");
    const headerValue = screen.getByLabelText<HTMLInputElement>("Header value");
    expect(headerName.placeholder).toBe("Header key");
    expect(headerName.type).toBe("text");
    expect(headerValue.type).toBe("text");
    fireEvent.change(headerName, {
      target: { value: "CF-Access-Client-Secret" },
    });
    fireEvent.change(headerValue, {
      target: { value: "s'ecret:two" },
    });

    await waitFor(() =>
      expect(screen.getByText(/enroll-once/).textContent).toContain(
        "--header 'CF-Access-Client-Secret: s'\"'\"'ecret:two'",
      ),
    );
    expect(requestMock.mock.calls.every(([, variables]) => !variables)).toBe(
      true,
    );
  });
});

vi.mock("@/hooks/use-server-url-settings", () => ({
  useServerUrlSettings: () => ({
    settings: serverUrlFixture,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
