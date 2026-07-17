import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("status");
  const active =
    status === "ONLINE" || status === "RUNNING" || status === "SUCCEEDED";
  const failed = status === "FAILED" || status === "TIMED_OUT";
  return (
    <Badge
      className={cn(
        active &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        failed && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
      variant={!active && !failed ? "secondary" : "outline"}
    >
      {t(status.toLowerCase())}
    </Badge>
  );
}
