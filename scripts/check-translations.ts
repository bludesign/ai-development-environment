#!/usr/bin/env tsx

import * as fs from "node:fs";
import * as path from "node:path";

type TranslationValue =
  string | number | boolean | null | TranslationData | TranslationValue[];

interface TranslationData {
  [key: string]: TranslationValue;
}

interface TranslationFile {
  locale: string;
  data: TranslationData;
  filePath: string;
}

interface KeyIssue {
  type: "missing" | "extra";
  key: string;
  locale: string;
}

interface MockValidationResult {
  isValid: boolean;
  issues: KeyIssue[];
  summary: {
    totalKeysInReference: number;
    totalKeysInMock: number;
    missingKeysCount: number;
    extraKeysCount: number;
  };
}

interface ValidationResult {
  isValid: boolean;
  issues: KeyIssue[];
  mockValidation?: MockValidationResult;
  summary: {
    totalKeys: number;
    locales: string[];
    missingKeysCount: number;
    extraKeysCount: number;
  };
}

function isTranslationData(value: unknown): value is TranslationData {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getAllKeys(obj: TranslationData, prefix = ""): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (isTranslationData(value)) {
      keys.push(...getAllKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }

  return keys;
}

function loadMockTranslations(mockFilePath: string): TranslationData | null {
  try {
    if (!fs.existsSync(mockFilePath)) {
      console.warn(`Mock translations file not found: ${mockFilePath}`);
      return null;
    }

    const content = fs.readFileSync(mockFilePath, "utf-8");
    const match = content.match(
      /const\s+mockTranslations\s*=\s*({[\s\S]*?})\s*;?\s*(?:const|$)/,
    );

    if (!match?.[1]) {
      throw new Error(
        "Could not find mockTranslations object in the mock file",
      );
    }

    const objectString = match[1];
    const jsonString = objectString
      .replace(/'/g, '"')
      .replace(/(\w+):/g, '"$1":')
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      parsed = Function(`"use strict"; return (${objectString})`)();
    }

    if (!isTranslationData(parsed)) {
      throw new Error("mockTranslations must be an object");
    }

    return parsed;
  } catch (error) {
    console.error(
      `Failed to load mock translations: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    return null;
  }
}

function validateMockTranslations(
  referenceTranslations: TranslationData,
  mockTranslations: TranslationData,
): MockValidationResult {
  const referenceKeys = new Set(getAllKeys(referenceTranslations));
  const mockKeys = new Set(getAllKeys(mockTranslations));
  const issues: KeyIssue[] = [];

  for (const key of referenceKeys) {
    if (!mockKeys.has(key)) {
      issues.push({ type: "missing", key, locale: "mock" });
    }
  }

  for (const key of mockKeys) {
    if (!referenceKeys.has(key)) {
      issues.push({ type: "extra", key, locale: "mock" });
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
    summary: {
      totalKeysInReference: referenceKeys.size,
      totalKeysInMock: mockKeys.size,
      missingKeysCount: issues.filter((issue) => issue.type === "missing")
        .length,
      extraKeysCount: issues.filter((issue) => issue.type === "extra").length,
    },
  };
}

function loadTranslationFiles(messagesDirectory: string): TranslationFile[] {
  const files = fs
    .readdirSync(messagesDirectory)
    .filter((file) => file.endsWith(".json"))
    .sort((first, second) => {
      if (first === "en.json") return -1;
      if (second === "en.json") return 1;
      return first.localeCompare(second);
    });

  return files.map((file) => {
    const filePath = path.join(messagesDirectory, file);
    const locale = path.basename(file, ".json");

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isTranslationData(parsed)) {
        throw new Error("translation file must contain an object");
      }

      return { locale, data: parsed, filePath };
    } catch (error) {
      throw new Error(
        `Failed to parse ${file}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  });
}

function validateTranslations(
  translationFiles: TranslationFile[],
  mockFilePath?: string,
): ValidationResult {
  if (translationFiles.length === 0) {
    throw new Error("No translation files found");
  }

  const reference = translationFiles[0];
  const referenceKeys = new Set(getAllKeys(reference.data));
  const issues: KeyIssue[] = [];

  for (const current of translationFiles.slice(1)) {
    const currentKeys = new Set(getAllKeys(current.data));

    for (const key of referenceKeys) {
      if (!currentKeys.has(key)) {
        issues.push({ type: "missing", key, locale: current.locale });
      }
    }

    for (const key of currentKeys) {
      if (!referenceKeys.has(key)) {
        issues.push({ type: "extra", key, locale: current.locale });
      }
    }
  }

  let mockValidation: MockValidationResult | undefined;
  if (mockFilePath) {
    const mockTranslations = loadMockTranslations(mockFilePath);
    if (mockTranslations) {
      mockValidation = validateMockTranslations(
        reference.data,
        mockTranslations,
      );
    }
  }

  return {
    isValid: issues.length === 0 && mockValidation?.isValid !== false,
    issues,
    mockValidation,
    summary: {
      totalKeys: referenceKeys.size,
      locales: translationFiles.map((file) => file.locale),
      missingKeysCount: issues.filter((issue) => issue.type === "missing")
        .length,
      extraKeysCount: issues.filter((issue) => issue.type === "extra").length,
    },
  };
}

function printResults(
  result: ValidationResult,
  translationFiles: TranslationFile[],
): void {
  console.log("🔍 Translation Key Validation Results");
  console.log("=====================================\n");
  console.log("📊 Summary:");
  console.log(`  Reference locale: ${translationFiles[0].locale}`);
  console.log(`  Total locales: ${result.summary.locales.join(", ")}`);
  console.log(`  Total keys in reference: ${result.summary.totalKeys}`);
  console.log(`  Missing keys: ${result.summary.missingKeysCount}`);
  console.log(`  Extra keys: ${result.summary.extraKeysCount}`);

  if (result.mockValidation) {
    console.log(
      `  Mock translations: ${result.mockValidation.isValid ? "✅ Valid" : "❌ Invalid"}`,
    );
    console.log(
      `  Mock missing keys: ${result.mockValidation.summary.missingKeysCount}`,
    );
    console.log(
      `  Mock extra keys: ${result.mockValidation.summary.extraKeysCount}`,
    );
  }
  console.log();

  if (result.isValid) {
    console.log(
      "✅ All translation files and mock translations have consistent keys!",
    );
    return;
  }

  console.log("❌ Found inconsistencies in translation keys:\n");
  const allIssues = [
    ...result.issues,
    ...(result.mockValidation?.issues ?? []),
  ];
  const issuesByLocale = allIssues.reduce<
    Record<string, { missing: string[]; extra: string[] }>
  >((accumulator, issue) => {
    accumulator[issue.locale] ??= { missing: [], extra: [] };
    accumulator[issue.locale][issue.type].push(issue.key);
    return accumulator;
  }, {});

  for (const [locale, issues] of Object.entries(issuesByLocale)) {
    const displayName =
      locale === "mock" ? "🎭 MOCK TRANSLATIONS" : `🌐 ${locale.toUpperCase()}`;
    console.log(`${displayName}:`);

    if (issues.missing.length > 0) {
      console.log(`  🔴 Missing keys (${issues.missing.length}):`);
      issues.missing.sort().forEach((key) => console.log(`    - ${key}`));
    }

    if (issues.extra.length > 0) {
      console.log(`  🟡 Extra keys (${issues.extra.length}):`);
      issues.extra.sort().forEach((key) => console.log(`    + ${key}`));
    }
    console.log();
  }

  console.log("💡 Suggestions:");
  console.log("  1. Add missing keys to the respective translation files");
  console.log(
    "  2. Remove extra keys or add them to the reference locale if they should be included",
  );
  console.log("  3. Use the reference locale as the source of truth");
  if (result.mockValidation && !result.mockValidation.isValid) {
    console.log("  4. Update src/__mocks__/next-intl.js to match English");
  }
}

function generateDetailedReport(
  result: ValidationResult,
  translationFiles: TranslationFile[],
): void {
  if (result.isValid) return;

  console.log("\n📋 Detailed Report:");
  console.log("==================\n");
  console.log("Key presence matrix:");
  console.log("(✓ = present, ✗ = missing)\n");

  const allKeys = new Set<string>();
  for (const file of translationFiles) {
    getAllKeys(file.data).forEach((key) => allKeys.add(key));
  }
  result.mockValidation?.issues.forEach((issue) => allKeys.add(issue.key));

  const locales = translationFiles.map((file) => file.locale.toUpperCase());
  if (result.mockValidation) locales.push("MOCK");
  console.log(["Key", ...locales].join("\t"));

  const problematicKeys = [...allKeys].sort().filter((key) => {
    const localePresence = translationFiles.filter((file) =>
      getAllKeys(file.data).includes(key),
    ).length;
    const mockPresent = result.mockValidation
      ? !result.mockValidation.issues.some(
          (issue) => issue.key === key && issue.type === "missing",
        )
      : false;
    return (
      localePresence + (mockPresent ? 1 : 0) !==
      translationFiles.length + (result.mockValidation ? 1 : 0)
    );
  });

  for (const key of problematicKeys.slice(0, 20)) {
    const row = [
      key,
      ...translationFiles.map((file) =>
        getAllKeys(file.data).includes(key) ? "✓" : "✗",
      ),
    ];
    if (result.mockValidation) {
      row.push(
        result.mockValidation.issues.some(
          (issue) => issue.key === key && issue.type === "missing",
        )
          ? "✗"
          : "✓",
      );
    }
    console.log(row.join("\t"));
  }

  if (problematicKeys.length > 20) {
    console.log(
      `\n... and ${problematicKeys.length - 20} more problematic keys`,
    );
  }
}

function main(): void {
  try {
    const messagesDirectory = path.join(__dirname, "..", "messages");
    const mockFilePath = path.join(
      __dirname,
      "..",
      "src",
      "__mocks__",
      "next-intl.js",
    );

    if (!fs.existsSync(messagesDirectory)) {
      throw new Error(`Messages directory not found: ${messagesDirectory}`);
    }

    console.log(`Loading translation files from: ${messagesDirectory}`);
    console.log(`Checking mock translations at: ${mockFilePath}\n`);

    const translationFiles = loadTranslationFiles(messagesDirectory);
    console.log(`Found ${translationFiles.length} translation files:`);
    translationFiles.forEach((file) =>
      console.log(`  - ${file.locale}: ${getAllKeys(file.data).length} keys`),
    );
    console.log();

    const result = validateTranslations(translationFiles, mockFilePath);
    printResults(result, translationFiles);
    generateDetailedReport(result, translationFiles);

    if (!result.isValid) process.exit(1);
  } catch (error) {
    console.error(
      "❌ Error:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export {
  generateDetailedReport,
  getAllKeys,
  loadMockTranslations,
  loadTranslationFiles,
  printResults,
  validateMockTranslations,
  validateTranslations,
  type KeyIssue,
  type MockValidationResult,
  type TranslationFile,
  type ValidationResult,
};
