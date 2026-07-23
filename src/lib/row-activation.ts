import type { MouseEvent } from "react";

/**
 * How a control inside a clickable row announces itself on hover: a soft chip
 * that lights up under the pointer, rather than an underline. The negative
 * margin cancels the padding, so the chip grows into the cell's own padding
 * without shifting the text out of line with its column heading.
 */
export const rowLinkClass =
  "-mx-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/**
 * Whether a click on a table row was aimed at the row itself rather than at
 * something inside it. A row-wide "open this" handler would otherwise swallow
 * every link, button, and checkbox it contains, so anything interactive — or
 * any handler that already claimed the event — opts the row out.
 */
export function isRowActivation(event: MouseEvent<HTMLElement>) {
  if (event.defaultPrevented || event.button !== 0) return false;
  const target = event.target;
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) {
    return false;
  }
  return !target.closest(
    "a, button, input, select, textarea, [role='button'], [role='link'], [role='menuitem']",
  );
}
