import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { JiraRichTextBlock, JiraTextComposer } from "./rich-text";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

    const viewMenu = screen.getByRole("button", { name: "Rendered" });
    expect(viewMenu.getAttribute("data-size")).toBe("xs");
    expect(viewMenu.getAttribute("data-variant")).toBe("outline");
    expect(viewMenu.querySelector(".lucide-eye")).not.toBeNull();
    fireEvent.pointerDown(viewMenu, { button: 0, ctrlKey: false });
    const rawItem = screen.getByRole("menuitemradio", { name: "Raw" });
    expect(rawItem.querySelector(".lucide-braces")).not.toBeNull();
    fireEvent.click(rawItem);
    expect(
      screen
        .getByRole("button", { name: "Raw" })
        .querySelector(".lucide-braces"),
    ).not.toBeNull();
    expect(
      screen.getByText("**Safe** <script>alert(1)</script>"),
    ).toBeDefined();
  });

  test("switches between rendered, Markdown, and exact raw ADF", () => {
    render(
      <JiraRichTextBlock
        content={{
          format: "ADF",
          raw: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "Deployment" }],
              },
            ],
          },
          rawText: '{"type":"doc","version":1}',
          markdown:
            '<!-- adf:paragraph attrs=\'{"localId":"794242e5a900"}\' -->\n\n## Deployment',
          wikiMarkup: "h2. Deployment",
        }}
        value={null}
      />,
    );

    expect(screen.getByText("Deployment").closest("h2")).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Rendered" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Markdown" }));
    expect(screen.getByText("## Deployment").tagName).toBe("PRE");
    expect(screen.queryByText(/adf:paragraph/)).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Markdown" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Raw" }));
    expect(screen.getByText('{"type":"doc","version":1}').tagName).toBe("PRE");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Raw" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Rendered" }));
    expect(screen.getByText("Deployment").closest("h2")).not.toBeNull();
  });

  test("copies the exact underlying content", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<JiraRichTextBlock value="h2. Raw heading" />);
    const copyButton = screen.getByRole("button", { name: "Copy" });
    expect(copyButton.textContent).toBe("Copy");
    expect(copyButton.getAttribute("data-size")).toBe("xs");
    expect(copyButton.getAttribute("data-variant")).toBe("outline");

    await act(async () => fireEvent.click(copyButton));
    expect(writeText).toHaveBeenCalledWith("h2. Raw heading");
    expect(copyButton.querySelector(".lucide-check")).not.toBeNull();

    act(() => vi.advanceTimersByTime(2_000));
    expect(copyButton.querySelector(".lucide-copy")).not.toBeNull();
  });
});

describe("JiraTextComposer", () => {
  test("uses a compact outlined preview button", () => {
    render(
      <JiraTextComposer
        busy={false}
        onSubmit={vi.fn()}
        submitLabel="Add comment"
      />,
    );

    const previewButton = screen.getByRole("button", { name: "Preview" });
    expect(previewButton.getAttribute("data-size")).toBe("xs");
    expect(previewButton.getAttribute("data-variant")).toBe("outline");

    const formatMenu = screen.getByRole("button", { name: "Markdown" });
    expect(formatMenu.getAttribute("data-size")).toBe("xs");
    expect(formatMenu.getAttribute("data-variant")).toBe("outline");
    expect(formatMenu.querySelector(".lucide-file-code")).not.toBeNull();
    expect(formatMenu.querySelector(".lucide-chevron-down")).not.toBeNull();

    fireEvent.pointerDown(formatMenu, { button: 0, ctrlKey: false });
    const wikiItem = screen.getByRole("menuitemradio", { name: "Jira Wiki" });
    expect(wikiItem.querySelector(".lucide-book-open-text")).not.toBeNull();
    fireEvent.click(wikiItem);
    expect(
      screen
        .getByRole("button", { name: "Jira Wiki" })
        .querySelector(".lucide-chevron-down"),
    ).not.toBeNull();
  });

  test("submits an empty value when the composer allows it", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <JiraTextComposer
        allowEmpty
        busy={false}
        initialValue="Existing description"
        onSubmit={onSubmit}
        submitLabel="Save description"
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
      target: { value: "" },
    });
    const submit = screen.getByRole("button", { name: "Save description" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    await act(async () => fireEvent.click(submit));
    expect(onSubmit).toHaveBeenCalledWith({ format: "MARKDOWN", value: "" });
  });
});
