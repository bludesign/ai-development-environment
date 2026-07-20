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
  test("uses the public origin for copied links and disables install off-device", async () => {
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
      "/en/builds/build-1?source=desktop#artifacts",
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

    expect(
      (
        screen.getByRole("button", {
          name: "Install on device",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText("Open this page on an iPhone or iPad to install."),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Copy install link" }));
    await waitFor(() =>
      expect(copyTextMock).toHaveBeenCalledWith(
        "https://ota.example.com/en/builds/build-1?source=desktop#artifacts",
      ),
    );
  });
});
