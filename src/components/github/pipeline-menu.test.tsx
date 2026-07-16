import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { RetryPipelineButton } from "./pipeline-menu";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(controlPlaneRequest).mockReset();
});

describe("RetryPipelineButton", () => {
  test("explains when GitHub App setup is required", () => {
    render(
      <RetryPipelineButton
        pipeline={{
          id: "check-suite-1",
          name: "CI",
          status: "FAILURE",
          url: "https://github.com/acme/widgets/actions/runs/1",
          checkSuiteId: "check-suite-1",
          canRetry: false,
          retryUnavailableReason: "GITHUB_APP_NOT_CONFIGURED",
        }}
        repositoryId="repository-1"
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText(
        "Configure and verify a GitHub App in Settings to retry this workflow.",
      ),
    ).toBeDefined();
  });
});
