export function formatResourceBytes(value: number, locale: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    value / 1024 ** unitIndex,
  )} ${units[unitIndex]}`;
}

export function ResourceUsage({
  label,
  total,
  free,
  locale,
  unavailable,
  usedLabel,
  freeLabel,
  compact = false,
}: {
  label: string;
  total?: number | null;
  free?: number | null;
  locale: string;
  unavailable: string;
  usedLabel: string;
  freeLabel: string;
  compact?: boolean;
}) {
  if (total == null || free == null || total <= 0) {
    return (
      <div className="rounded-lg border p-3">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{unavailable}</p>
      </div>
    );
  }
  const safeFree = Math.max(0, Math.min(free, total));
  const used = total - safeFree;
  const percentage = (used / total) * 100;
  return (
    <div className={`rounded-lg border ${compact ? "p-3" : "p-4"}`}>
      <div className="flex items-center justify-between gap-3">
        <p className={compact ? "text-sm font-medium" : "font-medium"}>
          {label}
        </p>
        <p className="text-xs text-muted-foreground">
          {Math.round(percentage)}%
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
        <div
          aria-label={`${label}: ${Math.round(percentage)}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(percentage)}
          className="h-full rounded-full bg-primary transition-[width]"
          role="progressbar"
          style={{ width: `${percentage}%` }}
        />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">{usedLabel}</dt>
          <dd>{formatResourceBytes(used, locale)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{freeLabel}</dt>
          <dd>{formatResourceBytes(safeFree, locale)}</dd>
        </div>
      </dl>
    </div>
  );
}
