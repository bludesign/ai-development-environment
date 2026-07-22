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
  test("switches the enrollment command between the page origin and local server origins", async () => {
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
    expect(code.textContent).toContain(`--server ${window.location.origin}`);

    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Server address" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    const localOrigins = await screen.findAllByText("http://192.168.1.24:3000");
    fireEvent.click(
      localOrigins.find((element) => element.tagName === "SPAN") ??
        localOrigins[0],
    );

    await waitFor(() =>
      expect(code.textContent).toContain("--server http://192.168.1.24:3000"),
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
    fireEvent.change(screen.getByLabelText("Header name"), {
      target: { value: "CF-Access-Client-Secret" },
    });
    fireEvent.change(screen.getByLabelText("Header value"), {
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
