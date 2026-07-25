import { cleanup, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { CommandQuickActions } from "./command-quick-actions";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("CommandQuickActions", () => {
  test("shows only quick actions and gates an old agent", async () => {
    request.mockResolvedValue({
      eligibleCommandsForAgent: [
        {
          id: "quick",
          name: "Serve",
          description: "Start server",
          quickActionEnabled: true,
          quickActionIconKey: "terminal",
          quickActionButtonVariant: "default",
        },
        {
          id: "regular",
          name: "Migrate",
          description: "Run migration",
          quickActionEnabled: false,
          quickActionIconKey: "terminal",
          quickActionButtonVariant: "default",
        },
      ],
    } as never);
    render(<CommandQuickActions agentCapabilities={[]} agentId="agent-1" />);
    expect(
      (await screen.findByRole("button", { name: /Serve/ })).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
    expect(screen.queryByText("Migrate")).toBeNull();
    expect(screen.getByText("Upgrade agent")).toBeDefined();
  });
});
