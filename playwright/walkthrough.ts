import { ids } from "../scripts/mock-data/ids";

/**
 * Mirrors MOBILE_BREAKPOINT in `src/hooks/use-mobile.ts`, which decides whether the primary
 * navigation is a persistent sidebar or a sheet behind the header's toggle. The walkthrough
 * has to click one or the other, so it reads the viewport rather than the project name.
 */
export const MOBILE_BREAKPOINT = 768;

/** Where the tour opens, and — so the recording loops without a jump cut — where it ends. */
export const WALKTHROUGH_START = "/";

export type WalkthroughStop = {
  /** Stable name, used in the step titles the run logs. */
  name: string;
  /** Locale-relative path, as in `routes.ts`; `localeHref` prefixes the locale. */
  path: string;
} & (
  | {
      /** Clicks the primary navigation entry whose href matches `path`. */
      via: "nav";
    }
  | {
      /**
       * Clicks the card the way a reader would — a worktree card navigates to its own detail
       * page when any plain part of its surface is clicked, and the tour aims as near the
       * middle as the layout leaves clear.
       */
      via: "card";
      /**
       * Heading the card is found by. The card carries no link to `path` — its surface handler
       * does the navigating — so the tour identifies it by the branch it is titled with, and
       * the URL assertion afterwards is what proves the click landed on the right one.
       */
      title: string;
    }
);

/**
 * The guided tour recorded for the docs landing page, in order. Detail stops reference the
 * deterministic IDs the mock seed writes, so they always resolve to a populated record.
 *
 * `apiFeature` is the first worktree the overview lists, which is what makes it the detail stop:
 * its card sits within the desktop fold, so the tour reaches it without scrolling the page.
 */
export const WALKTHROUGH_STOPS: WalkthroughStop[] = [
  { name: "worktrees", path: "/worktrees", via: "nav" },
  {
    name: "worktree-detail",
    path: `/worktrees/${ids.worktrees.apiFeature}`,
    via: "card",
    title: "feature/oauth-device-flow",
  },
  { name: "sessions", path: "/sessions", via: "nav" },
  { name: "action-center", path: WALKTHROUGH_START, via: "nav" },
];

/**
 * Marks every click and tap in the recording with a dot that pulses out and fades — the only
 * thing standing in for a pointer, since a video of a cursor sliding around reads as noise.
 *
 * This runs as an init script rather than using Playwright's built-in video overlay because
 * that overlay is all-or-nothing: its dot arrives bundled with a cursor sprite and an action
 * label, and the option that controls how long it lingers delays *every* action, so a pointer
 * move costs as much as a click. A dozen lines of page script are cheaper and also mark the
 * taps on the mobile projects, which no cursor could.
 *
 * Every stop after the first is a client-side navigation, so the document — and with it a dot
 * mid-animation — survives the move to the next page.
 */
export function markClicks(): void {
  window.addEventListener(
    "pointerdown",
    (event) => {
      const dot = document.createElement("div");
      dot.style.cssText = [
        "position:fixed",
        `left:${event.clientX}px`,
        `top:${event.clientY}px`,
        "width:22px",
        "height:22px",
        "margin:-11px 0 0 -11px",
        "border-radius:9999px",
        "background:rgb(239,68,68)",
        "box-shadow:0 0 0 6px rgba(239,68,68,0.28)",
        "pointer-events:none",
        "z-index:2147483647",
      ].join(";");
      document.body.appendChild(dot);
      // Pop, hold, then fade. The hold is the point: a dot that starts fading on the frame it
      // appears is gone within a frame or two of video and reads as a compression artefact.
      dot
        .animate(
          [
            { transform: "scale(0.4)", opacity: 0 },
            { transform: "scale(1)", opacity: 1, offset: 0.2 },
            { transform: "scale(1)", opacity: 1, offset: 0.62 },
            { transform: "scale(2.1)", opacity: 0 },
          ],
          { duration: 720, easing: "ease-out" },
        )
        .finished.then(() => dot.remove())
        .catch(() => dot.remove());
    },
    { capture: true },
  );
}

/** Locale-prefixed href, matching what next-intl's `Link` renders for a destination. */
export function localeHref(path: string): string {
  return path === "/" ? "/en" : `/en${path}`;
}

/** Widest video Playwright is asked to produce. The desktop projects record at exactly this. */
const MAX_VIDEO_WIDTH = 1920;

/** VP8 rejects odd frame dimensions, so every side is rounded to an even number of pixels. */
function toEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Video canvas for a viewport, which is the viewport itself up to `MAX_VIDEO_WIDTH`. It is not
 * worth asking for more: Playwright only ever scales a frame *down* into the size it is given,
 * so a size above the viewport's CSS pixels pads the picture rather than sharpening it. That is
 * also the ceiling on the mobile projects, which record at their 390px viewport.
 */
export function walkthroughVideoSize(
  viewport: { width: number; height: number } | null,
): { width: number; height: number } {
  const source = viewport ?? { width: MAX_VIDEO_WIDTH, height: 1080 };
  const scale = Math.min(1, MAX_VIDEO_WIDTH / source.width);
  return {
    width: toEven(source.width * scale),
    height: toEven(source.height * scale),
  };
}
