import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { useIntegrationAvailability } from "./use-integration-availability";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);
const answer = (github: boolean, gitlab: boolean, jira: boolean) => ({
  sourceControlIntegrationState: {
    github: { configured: github },
    gitlab: { configured: gitlab },
  },
  jiraSettings: { tokenConfigured: jira },
});
let configurationChanged: (provider: string) => void;

beforeEach(() => {
  request.mockReset();
  vi.mocked(controlPlaneSubscriptions).mockReturnValue({
    subscribe: vi.fn((_payload, sink) => {
      configurationChanged = (provider) =>
        sink.next({ data: { integrationConfigurationChanged: provider } });
      return vi.fn();
    }),
  } as never);
});
afterEach(cleanup);

test("is pending until the answer arrives, then reports each integration", async () => {
  let finish!: (value: ReturnType<typeof answer>) => void;
  request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }) as never,
  );
  const { result } = renderHook(() => useIntegrationAvailability());
  expect(result.current).toBe("pending");
  await act(async () => finish(answer(true, false, true)));
  expect(result.current).toEqual({ github: true, gitlab: false, jira: true });
  expect(request).toHaveBeenCalledTimes(1);
});

test("asks every integration, as before, when the answer cannot be read", async () => {
  request.mockRejectedValueOnce(new Error("Credential store unavailable"));
  const { result } = renderHook(() => useIntegrationAvailability());
  await waitFor(() =>
    expect(result.current).toEqual({ github: true, gitlab: true, jira: true }),
  );
});

test("reads the answer again when any integration is connected or removed", async () => {
  request.mockResolvedValueOnce(answer(true, false, false) as never);
  const { result } = renderHook(() => useIntegrationAvailability());
  await waitFor(() =>
    expect(result.current).toEqual({
      github: true,
      gitlab: false,
      jira: false,
    }),
  );

  request.mockResolvedValueOnce(answer(true, true, false) as never);
  act(() => configurationChanged("gitlab"));
  await waitFor(() =>
    expect(result.current).toEqual({ github: true, gitlab: true, jira: false }),
  );
  expect(request).toHaveBeenCalledTimes(2);
});
