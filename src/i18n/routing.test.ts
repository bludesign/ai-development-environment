import { describe, expect, test } from "vitest";

import { locales, routing } from "@/i18n/routing";

describe("i18n routing", () => {
  test("uses the Processor locale set and unprefixed English routes", () => {
    expect(locales).toEqual(["en", "es", "fr", "de"]);
    expect(routing.locales).toEqual(locales);
    expect(routing.defaultLocale).toBe("en");
    expect(routing.localePrefix).toBe("as-needed");
  });
});
