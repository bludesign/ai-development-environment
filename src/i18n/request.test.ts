import { describe, expect, test } from "vitest";

import requestConfig from "@/i18n/request";

type RequestConfigCallback = (options: {
  requestLocale: Promise<string | undefined>;
}) => Promise<{
  locale: string;
  messages: Record<string, unknown>;
}>;

const resolveRequestConfig = requestConfig as unknown as RequestConfigCallback;

describe("i18n request configuration", () => {
  test("loads messages for a supported locale", async () => {
    const result = await resolveRequestConfig({
      requestLocale: Promise.resolve("es"),
    });

    expect(result.locale).toBe("es");
    expect(result.messages.shell).toBeDefined();
  });

  test("falls back to English for an unsupported locale", async () => {
    const result = await resolveRequestConfig({
      requestLocale: Promise.resolve("invalid"),
    });

    expect(result.locale).toBe("en");
    expect(result.messages.metadata).toBeDefined();
  });
});
