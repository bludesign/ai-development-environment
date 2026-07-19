import { describe, expect, test } from "vitest";

import { plistDocument, plistValue, xmlEscape } from "./plist";

describe("xmlEscape", () => {
  test("escapes every reserved character", () => {
    expect(xmlEscape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  test("escapes ampersands before the entities it introduces", () => {
    expect(xmlEscape("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });
});

describe("plistValue", () => {
  test("writes booleans as empty elements", () => {
    expect(plistValue(true)).toBe("<true/>");
    expect(plistValue(false)).toBe("<false/>");
  });

  test("escapes string contents", () => {
    expect(plistValue(`Ben & Jerry's`)).toBe(
      "<string>Ben &amp; Jerry&apos;s</string>",
    );
  });

  test("writes integers", () => {
    expect(plistValue(42)).toBe("<integer>42</integer>");
  });

  test("rejects non-integer numbers", () => {
    expect(() => plistValue(1.5)).toThrow("Unsupported plist value");
  });

  test("writes arrays", () => {
    expect(plistValue(["a", "b"])).toBe(
      "<array><string>a</string><string>b</string></array>",
    );
  });

  test("writes an empty array", () => {
    expect(plistValue([])).toBe("<array></array>");
  });

  test("writes dictionaries and escapes keys", () => {
    expect(plistValue({ "a&b": "c" })).toBe(
      "<dict><key>a&amp;b</key><string>c</string></dict>",
    );
  });

  test("nests arrays inside dictionaries", () => {
    expect(plistValue({ items: [{ kind: "software" }] })).toBe(
      "<dict><key>items</key><array><dict><key>kind</key><string>software</string></dict></array></dict>",
    );
  });

  test("rejects unsupported values", () => {
    expect(() => plistValue(null)).toThrow("Unsupported plist value");
    expect(() => plistValue(undefined)).toThrow("Unsupported plist value");
  });
});

describe("plistDocument", () => {
  test("wraps the value in a plist header", () => {
    const document = plistDocument({ kind: "software" });
    expect(document).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(document).toContain("<!DOCTYPE plist PUBLIC");
    expect(document).toContain(
      `<plist version="1.0"><dict><key>kind</key><string>software</string></dict></plist>`,
    );
    expect(document.endsWith("\n")).toBe(true);
  });
});
