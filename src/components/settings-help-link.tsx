import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

export function SettingsHelpLink({
  children,
  href,
}: {
  children: ReactNode;
  href: string;
}) {
  return (
    <a
      className="inline-flex items-center gap-1 text-primary hover:underline"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
    </a>
  );
}
