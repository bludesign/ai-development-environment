import { describe, expect, test } from "vitest";

import {
  parseRequestHeader,
  redactedRequestHeaders,
  requestHeaders,
} from "./request-headers.js";

describe("agent request headers", () => {
  test("parses repeated RFC-safe headers and preserves colons in values", () => {
    expect(
      requestHeaders([
        "CF-Access-Client-Id: client-id",
        "CF-Access-Client-Secret: secret:with:colons",
      ]),
    ).toEqual({
      "CF-Access-Client-Id": "client-id",
      "CF-Access-Client-Secret": "secret:with:colons",
    });
  });

  test.each([
    "missing-separator",
    ": missing-name",
    "Bad Header: value",
    "Header: ",
    "Header: first\nsecond",
    "Header: first\rsecond",
    "Header: first\0second",
    "Header: first\x01second",
    "Header: 🔐",
  ])("rejects invalid header input %j", (value) => {
    expect(() => parseRequestHeader(value)).toThrow();
  });

  test("redacts every configured value", () => {
    expect(
      redactedRequestHeaders({
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "top-secret",
      }),
    ).toEqual({
      "CF-Access-Client-Id": "[redacted]",
      "CF-Access-Client-Secret": "[redacted]",
    });
  });
});
