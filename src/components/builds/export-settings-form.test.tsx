import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import {
  DEFAULT_EXPORT_SETTINGS,
  ExportSettingsForm,
} from "./export-settings-form";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const subscribe = vi.fn(() => vi.fn());

beforeEach(() => {
  subscribe.mockClear();
  subscriptions.mockReturnValue({ subscribe } as never);
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query ExportSigningInventoryJob")) {
      return {
        agentJob: {
          id: "refresh-job-1",
          agentId: "agent-1",
          status: "SUCCEEDED",
          error: null,
        },
      } as never;
    }
    if (operation.includes("query ExportSigningInventory {")) {
      return {
        signingAgents: [{ supported: true }],
        signingCertificates: [],
        signingProfiles: [],
      } as never;
    }
    if (operation.includes("mutation RefreshExportSigningInventory")) {
      return {
        refreshSigningAssets: [
          {
            id: "refresh-job-1",
            agentId: "agent-1",
            status: "SUCCEEDED",
            error: null,
          },
        ],
      } as never;
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExportSettingsForm", () => {
  test("refreshes signing inventory from agents and reloads the available profiles", async () => {
    render(
      <ExportSettingsForm
        onChange={vi.fn()}
        value={{
          ...DEFAULT_EXPORT_SETTINGS,
          signingStyle: "MANUAL",
        }}
      />,
    );

    const refresh = await screen.findByRole("button", {
      name: "Refresh inventory",
    });
    await waitFor(() =>
      expect((refresh as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(refresh);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RefreshExportSigningInventory"),
      ),
    );
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([query]) =>
          String(query).includes("query ExportSigningInventory {"),
        ),
      ).toHaveLength(2),
    );
  });
});
