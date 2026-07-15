// @vitest-environment node
import { describe, expect, test } from "vitest";

import {
  assertDatabaseProviderMatchesUrl,
  databaseProviderFromUrl,
} from "./prisma-client";

describe("databaseProviderFromUrl", () => {
  test.each([
    ["file:./prisma/dev.db", "sqlite"],
    ["postgres://user:password@localhost/database", "postgresql"],
    ["postgresql://user:password@localhost/database", "postgresql"],
  ] as const)("maps %s to %s", (url, provider) => {
    expect(databaseProviderFromUrl(url)).toBe(provider);
  });

  test("rejects unsupported URL schemes without echoing credentials", () => {
    expect(() =>
      databaseProviderFromUrl("mysql://user:secret@localhost/database"),
    ).toThrow('Unsupported DATABASE_URL scheme "mysql"');
  });
});

describe("assertDatabaseProviderMatchesUrl", () => {
  test("accepts a URL matching the generated provider", () => {
    expect(
      assertDatabaseProviderMatchesUrl("file:./prisma/dev.db", "sqlite"),
    ).toBe("sqlite");
  });

  test("rejects a URL for a different generated provider", () => {
    expect(() =>
      assertDatabaseProviderMatchesUrl(
        "postgresql://user:secret@localhost/database",
        "sqlite",
      ),
    ).toThrow(
      "DATABASE_URL requires the postgresql provider, but this Prisma client was generated for sqlite",
    );
  });
});
