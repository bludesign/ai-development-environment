import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { ActionCenterSettingsCard } from "./action-center-settings";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
afterEach(() => vi.clearAllMocks());

test("loads enabled defaults and saves the confirmation and both counter switches", async () => {
  request.mockResolvedValue({
    actionCenterSettings: {
      maximumRequestAgeDays: 30,
      showMyRequestsInSidebar: true,
      showReviewRequestsInSidebar: true,
      confirmClearAllNotifications: true,
      showIntegrationCountsInSidebar: true,
      showWorktreeCountsInSidebar: true,
    },
  } as never);
  render(<ActionCenterSettingsCard />);
  const save = screen.getByRole("button", { name: "Save settings" });
  await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  for (const name of [
    "Confirm before clearing all notifications",
    "Show pull/merge request and Actions/Pipelines counters",
    "Show Dirty and Off Main counters",
  ]) {
    const checkbox = screen.getByRole("checkbox", { name });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(checkbox);
  }
  fireEvent.click(save);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation SaveActionCenterSettings"),
      {
        input: {
          maximumRequestAgeDays: 30,
          showMyRequestsInSidebar: true,
          showReviewRequestsInSidebar: true,
          confirmClearAllNotifications: false,
          showIntegrationCountsInSidebar: false,
          showWorktreeCountsInSidebar: false,
        },
      },
    ),
  );
});
