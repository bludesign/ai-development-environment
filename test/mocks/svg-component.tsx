import type { SVGProps } from "react";

/**
 * Next builds `.svg` imports into React components through SVGR (see
 * next.config.ts). Vitest resolves them to a URL string instead, which throws
 * when rendered as a component, so tests get this stand-in element.
 */
export default function SvgComponent(props: SVGProps<SVGSVGElement>) {
  return <svg {...props} />;
}
