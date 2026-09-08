import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraCommentView, JiraTicketDetail } from "@/services/jira/types";
import { JiraTicketComments } from "./ticket-comments";
vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
vi.mock("./rich-text", () => ({
  JiraRichTextBlock: ({ value }: { value: string }) => <p>{value}</p>,
  JiraTextComposer: () => null,
}));
const request = vi.mocked(controlPlaneRequest);
const comments = (from: number, to: number): JiraCommentView[] =>
  Array.from({ length: to - from }, (_, i) => ({
    id: String(from + i),
    body: `Comment ${from + i}`,
    content: null,
    author: null,
    createdAt: null,
    updatedAt: null,
  }));
const ticket = (total: number) =>
  ({
    key: "APP-1",
    comments: comments(total - 50, total),
    commentsTotal: total,
  }) as JiraTicketDetail;
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test("defers older pages and keeps the loaded window after a newer ticket snapshot", async () => {
  request.mockImplementation(async (_query, input) => {
    const { offset, snapshotTotal } = input as {
      offset: number;
      snapshotTotal: number;
    };
    return {
      jiraTicketComments: {
        items: comments(
          Math.max(0, snapshotTotal - offset - 50),
          snapshotTotal - offset,
        ),
        total: snapshotTotal,
      },
    } as never;
  });
  const view = render(
    <JiraTicketComments
      ticket={ticket(150)}
      onTicketChange={() => undefined}
    />,
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Comment 50");
  expect(request).toHaveBeenCalledTimes(1);
  view.rerender(
    <JiraTicketComments
      ticket={ticket(151)}
      onTicketChange={() => undefined}
    />,
  );
  await screen.findByText("Comment 150");
  await waitFor(() => expect(screen.queryByText("Comment 50")).toBeNull());
  expect(screen.getByText("Comment 51")).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(2);
});
test("aborts an older-page read on unmount", async () => {
  let signal: AbortSignal | undefined;
  request.mockImplementation((_query, _variables, options) => {
    signal = options?.signal;
    return new Promise(() => undefined);
  });
  const view = render(
    <JiraTicketComments
      ticket={ticket(150)}
      onTicketChange={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(signal?.aborted).toBe(false);
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
