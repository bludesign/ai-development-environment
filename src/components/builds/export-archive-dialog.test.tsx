import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { ExportArchiveDialog } from "./export-archive-dialog";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("maps Developer ID profiles without requiring one for every bundle", async () => {
  const request = vi.mocked(controlPlaneRequest);
  request.mockImplementation(async (query) => {
    if (query.includes("query BuildSigningOptions")) {
      return {
        buildSigningOptions: {
          teams: [],
          identities: [],
          profiles: [
            {
              uuid: "developer-id-profile",
              name: "Mac distribution profile",
              type: "DEVELOPER_ID",
              bundleId: "com.example.app",
              platforms: ["OSX"],
              expired: false,
              certificateSha1s: [],
            },
          ],
          bundles: [
            { bundleId: "com.example.app", name: "Example Mac" },
            {
              bundleId: "com.example.app.extension",
              name: "Example Extension",
            },
          ],
        },
      } as never;
    }
    return {} as never;
  });

  render(
    <ExportArchiveDialog
      buildId="mac-build"
      onOpenChange={vi.fn()}
      onSaved={vi.fn().mockResolvedValue(undefined)}
      open
      platform="MACOS"
    />,
  );

  const choose = async (label: string, option: string) => {
    const field = screen.getByText(label).parentElement!;
    fireEvent.keyDown(within(field).getByRole("combobox"), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: option }));
  };

  await choose("Distribution method", "Developer ID");
  await choose("Signing style", "Manual");
  expect(await screen.findByText("Mac distribution profile")).toBeDefined();
  expect(screen.getByText("Use Xcode’s default")).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Export archive" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation ExportArchive"),
      expect.objectContaining({
        input: expect.objectContaining({
          settings: expect.objectContaining({
            method: "DEVELOPER_ID",
            signingStyle: "MANUAL",
            provisioningProfiles: { "com.example.app": "developer-id-profile" },
          }),
        }),
      }),
    ),
  );
});
