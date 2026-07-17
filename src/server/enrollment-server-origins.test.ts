import { describe, expect, test } from "vitest";

import { buildEnrollmentServerOrigins } from "./enrollment-server-origins";

describe("buildEnrollmentServerOrigins", () => {
  test("returns reachable IPv4 and IPv6 origins for the Next.js port", () => {
    expect(
      buildEnrollmentServerOrigins(
        {
          lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
          en0: [
            { address: "192.168.1.24", family: "IPv4", internal: false },
            { address: "fd12:3456::24", family: "IPv6", internal: false },
            { address: "fe80::24", family: "IPv6", internal: false },
          ],
          en1: [
            { address: "192.168.1.24", family: "IPv4", internal: false },
            { address: "10.0.0.9", family: "IPv4", internal: false },
          ],
        },
        3100,
      ),
    ).toEqual([
      "http://192.168.1.24:3100",
      "http://[fd12:3456::24]:3100",
      "http://10.0.0.9:3100",
    ]);
  });
});
