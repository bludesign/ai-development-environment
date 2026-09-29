import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import {
  GitLabApprovalBadge,
  GitLabMergeReadinessBadge,
  GitLabMergeRequestStateBadge,
} from "./merge-request-status";
import { GitLabMarkdown } from "./markdown";

afterEach(cleanup);

test("renders merged state and suppresses irrelevant readiness codes", () => {
  render(
    <>
      <GitLabMergeRequestStateBadge state="MERGED" />
      <GitLabMergeReadinessBadge state="MERGED" status="not_open" />
    </>,
  );
  expect(screen.getByText("Merged").className).toContain("purple");
  expect(screen.queryByText("MERGED")).toBeNull();
  expect(screen.queryByText("not_open")).toBeNull();
});

test("distinguishes unknown summaries from approval and safely handles new statuses", () => {
  render(
    <>
      <GitLabApprovalBadge state={null} />
      <GitLabMergeReadinessBadge state="OPENED" status="future_status" />
    </>,
  );
  expect(screen.getByText("Unavailable").className).toContain("slate");
  expect(screen.getByText("Merge readiness unavailable")).toBeDefined();
});

test("renders Markdown without enabling raw HTML or unsafe links", () => {
  const { container } = render(
    <GitLabMarkdown
      body={
        '**Description**\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n[unsafe](javascript:alert(1))'
      }
    />,
  );
  expect(container.querySelector("strong")?.textContent).toBe("Description");
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("unsafe").getAttribute("href")).not.toContain(
    "javascript:",
  );
});
