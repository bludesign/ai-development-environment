import { serverUrlFixture } from "../../../test/fixtures/server-urls";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { copyText } from "@/lib/browser-utils";

import { IosInstallButton } from "./ios-install-button";

vi.mock("@/lib/browser-utils", () => ({
  copyText: vi.fn(),
}));

const copyTextMock = vi.mocked(copyText);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IosInstallButton", () => {
  test("uses the shared default for copied links and disables install off-device", async () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      configurable: true,
      value: 0,
    });
    window.history.replaceState(
      {},
      "",
      "/en/dashboard/builds/build-1?source=desktop#artifacts",
    );

    render(
      <IosInstallButton
        artifactId="artifact-1"
        buildId="build-1"
        metadata={{
          bundleIdentifier: "com.example.app",
          exportMethod: "DEBUGGING",
        }}
        publicOrigin={{ origin: "https://ota.example.com", secure: true }}
      />,
    );

    const install = screen.getByRole("button", { name: "Install" });
    expect(install.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(install);
    expect(
      screen.getByText("Open this page on an iPhone or iPad to install."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Copy install link" }));
    await waitFor(() =>
      expect(copyTextMock).toHaveBeenCalledWith(
        "http://127.0.0.1:3000/en/dashboard/builds/build-1?serverUrlKind=LOCAL",
      ),
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
