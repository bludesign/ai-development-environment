export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function plistValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "string") return `<string>${xmlEscape(value)}</string>`;
  if (typeof value === "number" && Number.isInteger(value)) {
    return `<integer>${value}</integer>`;
  }
  if (Array.isArray(value)) {
    return `<array>${value.map((entry) => plistValue(entry)).join("")}</array>`;
  }
  if (value && typeof value === "object") {
    return `<dict>${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `<key>${xmlEscape(key)}</key>${plistValue(entry)}`)
      .join("")}</dict>`;
  }
  throw new Error("Unsupported plist value");
}

export function plistDocument(value: unknown): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(value)}</plist>\n`;
}
