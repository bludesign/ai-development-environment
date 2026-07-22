/**
 * Shared timestamp formatting so detail pages render dates identically.
 */
export function dateTimeFormatter(locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDateTime(locale: string, value: string | null) {
  return value ? dateTimeFormatter(locale).format(new Date(value)) : "—";
}
