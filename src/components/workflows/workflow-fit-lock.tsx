"use client";

import { ControlButton, useReactFlow, useStore } from "@xyflow/react";
import { Lock, LockOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * Keeps a locked graph fitted to its pane. React Flow's `fitView` prop only
 * runs once on init, so a pane that changes size — a sidebar opening, a phone
 * rotating — or a graph that gains a step would otherwise drift out of frame
 * with panning disabled and no way to bring it back.
 *
 * Renders nothing; it has to sit inside `<ReactFlow>` to reach the store that
 * reports the pane's measured size.
 */
export function WorkflowFitLock({
  locked,
  signature,
}: {
  locked: boolean;
  /**
   * A value that changes when the graph's layout does. Node positions are
   * deliberately excluded so dragging a step in the editor does not yank the
   * viewport out from under the pointer.
   */
  signature: string;
}) {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  // Fitting against unmeasured nodes or a pane React Flow has not sized yet
  // computes a viewport from zeroes; both settle a tick later and re-run this.
  const initialized = useStore((state) => state.nodesInitialized);
  useEffect(() => {
    if (!locked || !initialized || !width || !height) return;
    void fitView();
  }, [fitView, height, initialized, locked, signature, width]);
  return null;
}

/**
 * Class for the `<ReactFlow>` wrapper of a locked graph. React Flow disables
 * panning in JavaScript, but its stylesheet pins `touch-action: none` on the
 * pane unconditionally, so on a touch screen a drag that starts over the graph
 * is swallowed: the graph refuses to move and the page underneath cannot
 * scroll. The rule this hooks into lives in `globals.css` rather than being a
 * Tailwind utility, because React Flow's stylesheet is imported unlayered and
 * would outrank anything in `@layer utilities`. Cards sit outside the pane and
 * are unaffected, so a tap still selects a step.
 */
export const workflowFitLockPaneClass = "workflow-fit-locked";

/**
 * The lock toggle, styled as one more button in React Flow's control stack.
 * It always names the action rather than the state: locked shows "unlock",
 * which is the only control left on screen while the zoom and fit buttons are
 * hidden.
 */
export function WorkflowFitLockButton({
  locked,
  onToggle,
}: {
  locked: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("workflows");
  const label = locked ? t("unlockView") : t("lockToFit");
  // React Flow's control icons are solid shapes, so its stylesheet forces
  // `fill: currentColor` on any svg in a control button. Lucide draws in
  // strokes, and filling one turns the lock into a blob.
  const icon = "fill-none!";
  return (
    <ControlButton aria-label={label} onClick={onToggle} title={label}>
      {locked ? <LockOpen className={icon} /> : <Lock className={icon} />}
    </ControlButton>
  );
}
