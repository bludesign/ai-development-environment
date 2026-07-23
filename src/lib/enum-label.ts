const PROVIDER_LABELS: Record<string, string> = {
  CLAUDE: "Claude",
  CODEX: "Codex",
  OPENCODE: "OpenCode",
};

/**
 * Renders a SCREAMING_SNAKE_CASE enum value as a badge-friendly label:
 * `IMPORTED_SYNCED` becomes `Imported Synced`. Values that already carry
 * their own casing (provider-supplied tool names, branches) are left alone.
 */
export function formatEnumLabel(value: string): string {
  if (!/^[A-Z0-9_]+$/.test(value)) return value;
  return value
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .join(" ");
}

/** Provider identifiers have brand casing that title casing would flatten. */
export function formatProviderLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? formatEnumLabel(provider);
}

/**
 * OpenCode reports models namespaced by their catalog provider, e.g.
 * `opencode-go/grok-code`. The namespace costs horizontal room in list views
 * without telling the reader anything the provider badge does not, so drop it.
 */
export function formatModelLabel(model: string): string {
  return model.replace(/^opencode-go\//i, "");
}

/**
 * Some catalogs carry a tier onto the end of the model name — OpenCode Zen
 * ships `MiniMax-M3 Free` beside Go's `MiniMax-M3`. The suffix is what tells
 * the two apart, so it has to survive, but it is not part of the name and
 * should not read with the same weight. Splitting it lets callers set it in
 * quieter type; everything without a suffix comes back as name alone.
 */
export function splitModelLabel(model: string): {
  name: string;
  qualifier?: string;
} {
  const label = formatModelLabel(model);
  const match = /^(.+?)\s+(Free)$/i.exec(label);
  return match ? { name: match[1], qualifier: match[2] } : { name: label };
}
