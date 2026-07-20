import { Badge } from "@/components/ui/badge";

import type { IosDeviceStatus } from "./types";

export function IosDeviceStatusBadge({
  label,
  status,
}: {
  label: string;
  status: IosDeviceStatus;
}) {
  const className = {
    PENDING:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    REGISTERING:
      "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    REGISTERED:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    REGISTRATION_FAILED:
      "border-destructive/30 bg-destructive/10 text-destructive",
    REJECTED: "border-muted-foreground/30 bg-muted text-muted-foreground",
  }[status];
  return <Badge className={className}>{label}</Badge>;
}
