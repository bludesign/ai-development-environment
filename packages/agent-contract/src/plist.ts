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

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeText(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-z]+);/g,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return ENTITIES[entity] ?? match;
    },
  );
}

type Tag = {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
};

/** Finds the next element tag, skipping declarations, doctypes, and comments. */
function nextTag(xml: string, from: number): Tag | null {
  let index = from;
  for (;;) {
    const start = xml.indexOf("<", index);
    if (start < 0) return null;
    if (xml.startsWith("<!--", start)) {
      const close = xml.indexOf("-->", start);
      if (close < 0) return null;
      index = close + 3;
      continue;
    }
    if (xml.startsWith("<?", start) || xml.startsWith("<!", start)) {
      const close = xml.indexOf(">", start);
      if (close < 0) return null;
      index = close + 1;
      continue;
    }
    const close = xml.indexOf(">", start);
    if (close < 0) return null;
    const raw = xml.slice(start + 1, close);
    const closing = raw.startsWith("/");
    const selfClosing = raw.endsWith("/");
    const name = raw
      .slice(closing ? 1 : 0, selfClosing ? raw.length - 1 : raw.length)
      .trim()
      .split(/\s/)[0]!;
    return { name, closing, selfClosing, end: close + 1 };
  }
}

function textUntilClose(
  xml: string,
  from: number,
  name: string,
): [string, number] {
  const close = xml.indexOf(`</${name}`, from);
  if (close < 0) throw new Error(`Unterminated <${name}> in plist`);
  const end = xml.indexOf(">", close);
  return [decodeText(xml.slice(from, close)), end + 1];
}

const MAX_DEPTH = 64;

function parseValue(
  xml: string,
  from: number,
  depth: number,
): [unknown, number] {
  if (depth > MAX_DEPTH) throw new Error("plist nesting is too deep");
  const tag = nextTag(xml, from);
  if (!tag || tag.closing) throw new Error("Expected a plist value");
  if (tag.selfClosing) {
    switch (tag.name) {
      case "true":
        return [true, tag.end];
      case "false":
        return [false, tag.end];
      case "dict":
        return [{}, tag.end];
      case "array":
        return [[], tag.end];
      default:
        return ["", tag.end];
    }
  }
  switch (tag.name) {
    case "dict": {
      const result: Record<string, unknown> = {};
      let cursor = tag.end;
      for (;;) {
        const next = nextTag(xml, cursor);
        if (!next) throw new Error("Unterminated <dict> in plist");
        if (next.closing && next.name === "dict") return [result, next.end];
        if (next.name !== "key") throw new Error("Expected <key> in <dict>");
        const [key, afterKey] = textUntilClose(xml, next.end, "key");
        const [value, afterValue] = parseValue(xml, afterKey, depth + 1);
        result[key] = value;
        cursor = afterValue;
      }
    }
    case "array": {
      const result: unknown[] = [];
      let cursor = tag.end;
      for (;;) {
        const next = nextTag(xml, cursor);
        if (!next) throw new Error("Unterminated <array> in plist");
        if (next.closing && next.name === "array") return [result, next.end];
        const [value, afterValue] = parseValue(xml, cursor, depth + 1);
        result.push(value);
        cursor = afterValue;
      }
    }
    case "integer":
    case "real": {
      const [text, end] = textUntilClose(xml, tag.end, tag.name);
      return [Number(text.trim()), end];
    }
    // Dates and data are returned verbatim: callers need the timestamp text and
    // never the certificate bytes, so decoding them would only cost memory.
    case "string":
    case "date":
    case "data": {
      const [text, end] = textUntilClose(xml, tag.end, tag.name);
      return [tag.name === "string" ? text : text.trim(), end];
    }
    default: {
      const [, end] = textUntilClose(xml, tag.end, tag.name);
      return [null, end];
    }
  }
}

/**
 * Reads an XML property list.
 *
 * `security cms -D` already decodes a provisioning profile to XML, so parsing it
 * here avoids spawning a plutil process per key across a large profile library.
 */
export function parsePlist(xml: string): unknown {
  const start = xml.indexOf("<plist");
  const from = start < 0 ? 0 : xml.indexOf(">", start) + 1;
  return parseValue(xml, from, 0)[0];
}
