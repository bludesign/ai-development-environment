export function createClientId(): string {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // Some browsers expose randomUUID but reject it outside a secure context.
  }
  if (globalThis.crypto?.getRandomValues) {
    try {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    } catch {
      // A timestamp plus random suffix is sufficient for an idempotency key.
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Turns a display name into the file-name-safe stem used by exports. Runs of
 * unsafe characters collapse to a single dash, and leading and trailing dashes
 * are dropped so a name like "!!!" falls back to the placeholder instead of
 * producing a file called "-.json".
 */
export function exportFileStem(name: string): string {
  return (
    name
      .replaceAll(/[^a-z0-9]+/gi, "-")
      .replaceAll(/^-+|-+$/g, "")
      .toLowerCase() || "export"
  );
}

export function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Saves several exports one after another. Browsers drop downloads fired in
 * the same tick, so each file is handed over on its own frame.
 */
export async function downloadJsonFiles(
  files: Array<{ value: unknown; filename: string }>,
): Promise<void> {
  for (const [index, file] of files.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    downloadJson(file.value, file.filename);
  }
}

export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // The Clipboard API can exist but reject outside a secure context.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy is not supported by this browser");
}
