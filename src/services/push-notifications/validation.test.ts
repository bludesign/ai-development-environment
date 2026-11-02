import { describe, expect, test } from "vitest";

import {
  APNS_PUSH_TYPES,
  normalizeDeviceToken,
  parseApnsRegistrationInput,
  validatePushEditor,
} from "./validation";

const tokenHex = "01".repeat(32);

describe("APNs validation", () => {
  test("normalizes equivalent HEX and Base64 device tokens", () => {
    const base64 = Buffer.from(tokenHex, "hex").toString("base64");
    expect(normalizeDeviceToken(tokenHex.toLowerCase(), "HEX")).toBe(tokenHex);
    expect(normalizeDeviceToken(base64, "BASE64")).toBe(tokenHex);
  });

  test.each([1, 16, 32, 64, 128])(
    "normalizes %i-byte tokens consistently",
    (length) => {
      const bytes = Buffer.alloc(length, 0xfb);
      const expected = bytes.toString("hex").toUpperCase();
      expect(normalizeDeviceToken(bytes.toString("hex"), "HEX")).toBe(expected);
      expect(normalizeDeviceToken(bytes.toString("base64"), "BASE64")).toBe(
        expected,
      );
      expect(normalizeDeviceToken(bytes.toString("base64url"), "BASE64")).toBe(
        expected,
      );
      expect(normalizeDeviceToken(`<${bytes.toString("hex")}>`, "HEX")).toBe(
        expected,
      );
    },
  );

  test.each(["", " ", "<>", "A", "ABC", "GG", "AA-BB", "AA!B"])(
    "rejects malformed hexadecimal %j",
    (token) => {
      expect(() => normalizeDeviceToken(token, "HEX")).toThrow(/hexadecimal/);
    },
  );

  test.each([
    "",
    "=",
    "A",
    "AQ=",
    "AQ===",
    "A===",
    "AB==",
    "AAA==",
    "AA!A",
    "AA AA",
  ])("rejects malformed Base64 %j", (token) => {
    expect(() => normalizeDeviceToken(token, "BASE64")).toThrow(/Base64/);
  });

  test("requires PushMagic for MDM registrations", () => {
    expect(() =>
      parseApnsRegistrationInput({
        clientRegistrationId: "installation-1",
        token: tokenHex,
        tokenEncoding: "HEX",
        topic: "com.example.mdm",
        environment: "PRODUCTION",
        supportedPushTypes: ["mdm"],
        displayName: "Managed iPhone",
      }),
    ).toThrow("pushMagic");
  });

  test.each([1, 16, 64, 128])(
    "normalizes variable-length %i-byte registrations from Base64",
    (length) => {
      const token = Buffer.alloc(length, 0xab);
      expect(
        parseApnsRegistrationInput({
          clientRegistrationId: "installation-1",
          token: token.toString("base64"),
          tokenEncoding: "BASE64",
          topic: "com.example.app",
          environment: "PRODUCTION",
          supportedPushTypes: ["alert"],
          displayName: "iPhone",
        }).token,
      ).toBe(token.toString("hex").toUpperCase());
    },
  );

  test.each(APNS_PUSH_TYPES)("validates the %s push type", (pushType) => {
    const suffixes: Partial<Record<(typeof APNS_PUSH_TYPES)[number], string>> =
      {
        complication: ".complication",
        fileprovider: ".pushkit.fileprovider",
        liveactivity: ".push-type.liveactivity",
        location: ".location-query",
        pushtotalk: ".voip-ptt",
        voip: ".voip",
        widgets: ".push-type.widgets",
        controls: ".push-type.controls",
      };
    const suffix = suffixes[pushType];
    const editor = {
      pushType,
      headers: {
        topic: `com.example.app${suffix ?? ""}`,
        priority: pushType === "background" ? 5 : 10,
      },
      aps: ["mdm", "background"].includes(pushType)
        ? {}
        : { alert: { title: "Hello" } },
      custom: {},
      credentialId: pushType === "mdm" ? "certificate-1" : null,
      ...(pushType === "liveactivity"
        ? {
            liveActivity: {
              timestamp: 1_784_500_000,
              event: "update",
              "content-state": { score: 2 },
            },
          }
        : {}),
    };
    expect(validatePushEditor(editor).editor.pushType).toBe(pushType);
  });

  test("enforces background priority and VoIP's larger byte limit", () => {
    expect(() =>
      validatePushEditor({
        pushType: "background",
        headers: { topic: "com.example.app", priority: 10 },
        aps: {},
        custom: {},
      }),
    ).toThrow("priority 5");

    expect(() =>
      validatePushEditor({
        pushType: "alert",
        headers: { topic: "com.example.app", priority: 10 },
        aps: { alert: { title: "Large" } },
        custom: { value: "x".repeat(4_500) },
      }),
    ).toThrow("4096");
    expect(
      validatePushEditor({
        pushType: "voip",
        headers: { topic: "com.example.app.voip", priority: 10 },
        aps: {},
        custom: { value: "x".repeat(4_500) },
      }).byteLength,
    ).toBeGreaterThan(4_096);
  });
});
