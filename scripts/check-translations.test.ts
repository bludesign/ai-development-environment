import { describe, expect, test } from "vitest";

import {
  validateTranslations,
  type TranslationFile,
} from "./check-translations";

function translationFile(
  locale: string,
  data: TranslationFile["data"],
): TranslationFile {
  return { locale, data, filePath: `${locale}.json` };
}

describe("validateTranslations", () => {
  test("rejects strings copied unchanged across every locale", () => {
    const result = validateTranslations([
      translationFile("en", { greeting: "Welcome" }),
      translationFile("de", { greeting: "Welcome" }),
      translationFile("es", { greeting: "Welcome" }),
    ]);

    expect(result.isValid).toBe(false);
    expect(result.identicalTranslations).toEqual([
      {
        key: "greeting",
        locales: ["en", "de", "es"],
        value: "Welcome",
      },
    ]);
    expect(result.summary.identicalTranslationsCount).toBe(1);
  });

  test("allows a value shared by only some locales", () => {
    const result = validateTranslations([
      translationFile("en", { navigation: "Navigation" }),
      translationFile("de", { navigation: "Navigation" }),
      translationFile("es", { navigation: "Navegación" }),
    ]);

    expect(result.isValid).toBe(true);
    expect(result.identicalTranslations).toEqual([]);
  });

  test("allows product names to stay identical in every locale", () => {
    const result = validateTranslations([
      translationFile("en", {
        metadata: { title: "AI Development Environment" },
        shell: { productName: "AI Development Environment" },
      }),
      translationFile("de", {
        metadata: { title: "AI Development Environment" },
        shell: { productName: "AI Development Environment" },
      }),
    ]);

    expect(result.isValid).toBe(true);
    expect(result.identicalTranslations).toEqual([]);
  });

  test("does not exempt other values assigned to product-name keys", () => {
    const result = validateTranslations([
      translationFile("en", {
        metadata: { title: "Welcome" },
      }),
      translationFile("de", {
        metadata: { title: "Welcome" },
      }),
    ]);

    expect(result.isValid).toBe(false);
    expect(result.identicalTranslations).toHaveLength(1);
  });

  test("does not report missing values as identical translations", () => {
    const result = validateTranslations([
      translationFile("en", { greeting: "Welcome" }),
      translationFile("de", {}),
    ]);

    expect(result.isValid).toBe(false);
    expect(result.issues).toEqual([
      { type: "missing", key: "greeting", locale: "de" },
    ]);
    expect(result.identicalTranslations).toEqual([]);
  });
});
