import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { JiraChange, JiraTicketDetail } from "@/services/jira/types";

import { JiraDescriptionHistory } from "./description-history";

afterEach(() => cleanup());

describe("JiraDescriptionHistory pagination", () => {
  test("offers older pages when the loaded page has no description edits", async () => {
    const changes: JiraChange[] = Array.from({ length: 50 }, (_, index) => ({
      id: `change-${index}`,
      author: null,
      createdAt: null,
      items: [
        {
          field: "Status",
          fieldId: "status",
          from: "To Do",
          to: "In Progress",
        },
      ],
    }));
    const load = vi.fn().mockResolvedValue(undefined);
    const ticket = {
      description: "Current description",
      descriptionContent: null,
      updatedAt: "2026-07-17T12:00:00.000Z",
    } as JiraTicketDetail;

    render(
      <JiraDescriptionHistory
        history={{
          changes,
          error: null,
          load,
          loading: false,
          reset: vi.fn(),
          total: 51,
        }}
        ticket={ticket}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Description history" }),
    );
    expect(
      await screen.findByText(
        "No previous description versions are available.",
      ),
    ).toBeDefined();
    const loadMore = screen.getByRole("button", { name: "Load more" });

    fireEvent.click(loadMore);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
