import * as React from "react";

import { cn } from "@/lib/utils";

function DetailList({ className, ...props }: React.ComponentProps<"dl">) {
  return <dl className={cn("grid gap-3 text-sm", className)} {...props} />;
}

function DetailItem({
  label,
  children,
  mono = false,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  label: string;
  mono?: boolean;
}) {
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-sm tabular-nums",
          mono && "break-all font-mono",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export { DetailItem, DetailList };
