import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CliHealthSettingsDialog } from "./cli-health-settings-dialog";

describe("CliHealthSettingsDialog", () => {
  afterEach(cleanup);

  test("edits, toggles, deletes, creates, and saves global checks", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CliHealthSettingsDialog
        checks={[
          {
            id: "node",
            name: "Node.js",
            command: "node --version",
            enabled: true,
          },
        ]}
        onOpenChange={vi.fn()}
        onSave={onSave}
        open
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Node runtime" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Enabled" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Node runtime" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add check" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Disk" },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "df -h" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith([
        { id: "", name: "Disk", command: "df -h", enabled: true },
      ]),
    );
  });

  test("keeps save disabled while required values are empty", () => {
    render(
      <CliHealthSettingsDialog
        checks={[]}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
        open
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add check" }));

    expect(
      (
        screen.getByRole("button", {
          name: "Save settings",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
