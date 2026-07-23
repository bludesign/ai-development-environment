import ClaudeCodeIcon from "@lobehub/icons-static-svg/icons/claudecode.svg";
import OpenAIIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import OpenCodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg";

import { cn } from "@/lib/utils";

const PROVIDER_ICONS = {
  CODEX: OpenAIIcon,
  CLAUDE: ClaudeCodeIcon,
  OPENCODE: OpenCodeIcon,
} as const;

/**
 * Brand mark for the agent that ran a job. The LobeHub logos are monochrome and
 * inherit `currentColor`, so they sit alongside Lucide icons without restyling.
 */
export function ProviderIcon({
  className,
  provider,
}: {
  className?: string;
  provider: string;
}) {
  const Icon = PROVIDER_ICONS[provider as keyof typeof PROVIDER_ICONS];
  if (!Icon) return null;
  return (
    <Icon aria-hidden="true" className={cn("size-4 shrink-0", className)} />
  );
}
