import {
  act,
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

import { DeviceDetailPage } from "./device-detail-page";
import { DevicesPage } from "./devices-page";
import type { IosDeviceRecord, IosDeviceSettings } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);
const udid = "00008030-001C2D3E4F50002E";
let notify: (() => void) | null = null;

function device(overrides: Partial<IosDeviceRecord> = {}): IosDeviceRecord {
  return {
    id: "device-1",
    udid,
    maskedUdid: "0000••••002E",
    displayName: "Test iPhone",
    product: "iPhone16,1",
    osVersion: "19.0",
    platform: "IOS",
    status: "PENDING",
    appleDeviceId: null,
    appleStatus: null,
    registrationError: null,
    registeredAt: null,
    lastSeenAt: "2026-07-20T02:00:00.000Z",
    lastIpAddress: "203.0.113.9",
    createdAt: "2026-07-20T01:00:00.000Z",
    updatedAt: "2026-07-20T02:00:00.000Z",
    enrollments: [
      {
        id: "enrollment-1",
        status: "COMPLETED",
        displayName: "Submitted label",
        expiresAt: "2026-07-20T01:30:00.000Z",
        downloadedAt: "2026-07-20T01:01:00.000Z",
        consumedAt: "2026-07-20T01:02:00.000Z",
        failureCode: null,
        createdAt: "2026-07-20T01:00:00.000Z",
        updatedAt: "2026-07-20T01:02:00.000Z",
      },
    ],
    ipObservations: [
      {
        id: "ip-1",
        ipAddress: "203.0.113.9",
        source: "PROFILE_RESPONSE",
        headerSource: "CLOUDFLARE",
        observedAt: "2026-07-20T01:02:00.000Z",
      },
    ],
    ...overrides,
  };
}

function settings(
  overrides: Partial<IosDeviceSettings> = {},
): IosDeviceSettings {
  return {
    organizationName: "Test",
    profileIdentifier: "com.example.device-enrollment",
    signerConfigured: true,
    signerFingerprint: "signer",
    signerCreatedAt: null,
    signerExpiresAt: null,
    appStoreConnectConfigured: false,
    appStoreConnectIssuerId: null,
    appStoreConnectKeyId: null,
    appStoreConnectPrivateKeyConfigured: false,
    appStoreConnectPrivateKeyFingerprint: null,
    appStoreConnectVerifiedAt: null,
    appStoreConnectLastTestedAt: null,
    appStoreConnectVerificationError: null,
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  notify = null;
  subscriptions.mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      notify = () =>
        sink.next({
          data: { iosDevicesChanged: { id: "device-1" } },
        } as never);
      return vi.fn();
    }),
  } as never);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
  request.mockReset();
  subscriptions.mockReset();
});

describe("DevicesPage", () => {
  test("lists masked devices, lifecycle dates, exports, and refreshes from the subscription", async () => {
    request.mockResolvedValue({ iosDevices: [device()] } as never);
    render(<DevicesPage />);

    const link = await screen.findByRole("link", { name: "Test iPhone" });
    expect(link.getAttribute("href")).toBe("/devices/device-1");
    expect(screen.getByText("0000••••002E")).toBeDefined();
    expect(screen.queryByText(udid)).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Export Apple TSV" })
        .getAttribute("href"),
    ).toBe("/api/ios/devices/export.tsv");
    expect(screen.getByText("Pending")).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Enrolled" }),
    ).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Apple registration" }),
    ).toBeDefined();
    expect(String(request.mock.calls[0]?.[0])).not.toMatch(/\sudid\s/);

    await act(async () => notify?.());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });
});

describe("DeviceDetailPage", () => {
  test("keeps the UDID masked until reveal, copies explicitly, and shows IP provenance", async () => {
    request.mockResolvedValue({
      iosDevice: device(),
      iosDeviceSettings: settings(),
    } as never);
    render(<DeviceDetailPage id="device-1" />);

    await screen.findByText("0000••••002E");
    expect(screen.queryByText(udid)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal device UDID" }));
    expect(screen.getByText(udid)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy device UDID" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(udid),
    );
    expect(screen.getByText("Cloudflare (CF-Connecting-IP)")).toBeDefined();
    expect(
      (
        screen.getByRole("button", {
          name: "Register with Apple",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Configure and verify App Store Connect/),
    ).toBeDefined();
  });
});
