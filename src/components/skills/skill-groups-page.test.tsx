import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { SkillGroupsPage } from "./skill-groups-page";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  push.mockReset();
  request.mockReset();
});

describe("SkillGroupsPage", () => {
  test("opens a group from anywhere on its table row", async () => {
    request.mockResolvedValue({
      skillsOverview: {
        groups: [
          {
            id: "group-1",
            name: "Swift foundations",
            updatedAt: new Date(0).toISOString(),
            skills: [{ id: "skill-1", name: "Swift review" }],
            repositories: [{ id: "repository-1", name: "Mobile" }],
          },
        ],
      },
    } as never);

    render(<SkillGroupsPage />);

    const row = await screen.findByRole("link", {
      name: /Swift foundations 1 1/i,
    });
    expect(row.tagName).toBe("TR");
    expect(screen.getAllByText("Skill groups")).toHaveLength(2);

    fireEvent.click(row);
    expect(push).toHaveBeenCalledWith("/skills/groups/group-1");

    push.mockClear();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/skills/groups/group-1");
  });
});
