import { describe, expect, test } from "vitest";

import { parsePlist, plistDocument, plistValue, xmlEscape } from "./plist";

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

const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AppIDName</key>
	<string>Server &amp; Watch</string>
	<key>DeveloperCertificates</key>
	<array>
		<data>MIIF3DCCBMSg</data>
	</array>
	<key>Entitlements</key>
	<dict>
		<key>application-identifier</key>
		<string>B88BRQ88KH.com.BluDesign.Server</string>
		<key>get-task-allow</key>
		<true/>
		<key>com.apple.developer.team-identifier</key>
		<string>B88BRQ88KH</string>
	</dict>
	<key>ExpirationDate</key>
	<date>2027-07-06T00:51:24Z</date>
	<key>IsXcodeManaged</key>
	<false/>
	<key>Name</key>
	<string>match Development com.BluDesign.Server</string>
	<key>Platform</key>
	<array>
		<string>iOS</string>
		<string>xrOS</string>
	</array>
	<key>ProvisionedDevices</key>
	<array>
		<string>00008030-001A2B3C</string>
	</array>
	<key>TeamIdentifier</key>
	<array>
		<string>B88BRQ88KH</string>
	</array>
	<key>TimeToLive</key>
	<integer>351</integer>
	<key>UUID</key>
	<string>bd5dba5a-5ab5-48ef-89c0-d5822e345538</string>
</dict>
</plist>`;

describe("parsePlist", () => {
  test("reads a provisioning profile", () => {
    const profile = parsePlist(PROFILE) as Record<string, unknown>;

    expect(profile.Name).toBe("match Development com.BluDesign.Server");
    expect(profile.UUID).toBe("bd5dba5a-5ab5-48ef-89c0-d5822e345538");
    expect(profile.TeamIdentifier).toEqual(["B88BRQ88KH"]);
    expect(profile.Platform).toEqual(["iOS", "xrOS"]);
    expect(profile.ProvisionedDevices).toEqual(["00008030-001A2B3C"]);
    expect(profile.IsXcodeManaged).toBe(false);
    expect(profile.TimeToLive).toBe(351);
    expect(profile.ExpirationDate).toBe("2027-07-06T00:51:24Z");
    expect(profile.AppIDName).toBe("Server & Watch");
  });

  test("reads nested entitlements", () => {
    const profile = parsePlist(PROFILE) as Record<string, unknown>;
    const entitlements = profile.Entitlements as Record<string, unknown>;

    expect(entitlements["application-identifier"]).toBe(
      "B88BRQ88KH.com.BluDesign.Server",
    );
    expect(entitlements["get-task-allow"]).toBe(true);
  });

  test("keeps certificate data undecoded", () => {
    const profile = parsePlist(PROFILE) as Record<string, unknown>;
    expect(profile.DeveloperCertificates).toEqual(["MIIF3DCCBMSg"]);
  });

  test("decodes entities including numeric references", () => {
    expect(
      parsePlist(
        `<plist version="1.0"><string>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65; &#x42;</string></plist>`,
      ),
    ).toBe(`a & b <c> "d" 'e' A B`);
  });

  test("reads empty and self-closing containers", () => {
    expect(
      parsePlist(
        `<plist version="1.0"><dict><key>a</key><array/></dict></plist>`,
      ),
    ).toEqual({ a: [] });
    expect(
      parsePlist(
        `<plist version="1.0"><dict><key>a</key><array></array></dict></plist>`,
      ),
    ).toEqual({ a: [] });
  });

  test("skips comments and declarations", () => {
    expect(
      parsePlist(
        `<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><!-- note --><dict><key>a</key><string>b</string></dict></plist>`,
      ),
    ).toEqual({ a: "b" });
  });

  test("round-trips values written by plistDocument", () => {
    const value = {
      items: [
        { assets: [{ kind: "software-package", url: "https://x/y?a=1&b=2" }] },
      ],
      count: 3,
      enabled: true,
    };
    expect(parsePlist(plistDocument(value))).toEqual(value);
  });

  test("rejects malformed documents", () => {
    expect(() =>
      parsePlist(`<plist version="1.0"><dict><key>a</key>`),
    ).toThrow();
    expect(() => parsePlist(`<plist version="1.0"><string>unclosed`)).toThrow();
  });
});
