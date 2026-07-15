import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }) {
  const active =
    status === "ONLINE" || status === "RUNNING" || status === "SUCCEEDED";
  const failed = status === "FAILED" || status === "TIMED_OUT";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        active && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        failed && "bg-destructive/15 text-destructive",
        !active && !failed && "bg-muted text-muted-foreground",
      )}
    >
      {status.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}
