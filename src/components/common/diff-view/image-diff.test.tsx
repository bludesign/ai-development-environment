import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CSSProperties, SyntheticEvent } from "react";

import { ImageDiff, type ImageDiffLabels } from "./image-diff";

/**
 * `next/image` swallows the load event unless the underlying element reports
 * itself complete, which jsdom never does. The component only ever asks the
 * browser for the decoded size, so a plain `img` is a faithful stand-in.
 */
vi.mock("next/image", () => ({
  default: ({
    alt,
    className,
    onLoad,
    src,
    style,
  }: {
    alt: string;
    className?: string;
    onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
    src: string;
    style?: CSSProperties;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      alt={alt}
      className={className}
      onLoad={onLoad}
      src={src}
      style={style}
    />
  ),
}));

const labels: ImageDiffLabels = {
  sideBySide: "Side by side",
  overlap: "Overlap",
  difference: "Difference",
  transparency: "Image transparency",
  sensitivity: "Difference sensitivity",
  differenceSummary: (percent: string) => `${percent}% of pixels differ`,
  comparing: "Comparing pixels",
  needsBothSides: "Both revisions are needed",
  failed: "Could not compare",
  identical: "No pixels differ",
  before: "Before",
  after: "After",
  missing: "No image on this side",
};

/** jsdom reports every image as 0x0, so the decoded size has to be planted. */
function loadWith(image: HTMLElement, width: number, height: number) {
  Object.defineProperty(image, "naturalWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(image, "naturalHeight", {
    configurable: true,
    value: height,
  });
  fireEvent.load(image);
}

afterEach(cleanup);

describe("ImageDiff", () => {
  test("sizes the overlap box to the base image's aspect ratio", () => {
    render(
      <ImageDiff after="/after.png" before="/before.png" labels={labels} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Overlap" }));

    const before = screen.getByAltText("Before");
    const box = before.parentElement;
    expect(box?.style.aspectRatio).toBe("");
    expect(box?.className).toContain("min-h-64");

    loadWith(before, 1200, 400);
    expect(box?.style.aspectRatio).toMatch(/^3(\s*\/\s*1)?$/);
    expect(box?.className).not.toContain("min-h-64");
  });

  test("measures the after side when there is no before image", () => {
    render(<ImageDiff after="/after.png" before={null} labels={labels} />);
    fireEvent.click(screen.getByRole("button", { name: "Overlap" }));

    const after = screen.getByAltText("After");
    loadWith(after, 800, 800);
    expect(after.parentElement?.style.aspectRatio).toMatch(/^1(\s*\/\s*1)?$/);
  });

  test("difference mode needs both revisions", () => {
    render(<ImageDiff after="/after.png" before={null} labels={labels} />);
    fireEvent.click(screen.getByRole("button", { name: "Difference" }));

    expect(screen.getByText("Both revisions are needed")).toBeDefined();
  });

  test("shows one slider per mode", () => {
    render(
      <ImageDiff after="/after.png" before="/before.png" labels={labels} />,
    );
    expect(screen.queryByLabelText("Image transparency")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Overlap" }));
    expect(screen.getByLabelText("Image transparency")).toBeDefined();
    expect(screen.queryByLabelText("Difference sensitivity")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Difference" }));
    expect(screen.getByLabelText("Difference sensitivity")).toBeDefined();
    expect(screen.queryByLabelText("Image transparency")).toBeNull();
  });
});
