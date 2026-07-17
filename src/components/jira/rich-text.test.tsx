import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { JiraRichTextBlock } from "./rich-text";

afterEach(() => cleanup());

describe("JiraRichTextBlock", () => {
  test("renders Markdown safely and toggles to exact raw content", () => {
    render(
      <JiraRichTextBlock
        content={{
          format: "MARKDOWN",
          raw: "**Safe** <script>alert(1)</script>",
          rawText: "**Safe** <script>alert(1)</script>",
          markdown: "**Safe** <script>alert(1)</script>",
          wikiMarkup: "*Safe* <script>alert(1)</script>",
        }}
        value="**Safe** <script>alert(1)</script>"
      />,
    );
    expect(screen.getByText("Safe").tagName).toBe("STRONG");
    expect(document.querySelector("script")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View raw" }));
    expect(
      screen.getByText("**Safe** <script>alert(1)</script>"),
    ).toBeDefined();
  });

  test("copies the exact underlying content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<JiraRichTextBlock value="h2. Raw heading" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy raw content" }));
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("h2. Raw heading"),
    );
  });
});
