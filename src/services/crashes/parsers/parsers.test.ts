import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { CrashParseError } from "../types";
import { detectAndParse } from "./index";

const fixtures = resolve(__dirname, "../__fixtures__");
const read = (name: string) => readFileSync(resolve(fixtures, name));
const APP_UUID = "776386D043863F249B215F7C02EB2873";

function appFrames(crash: ReturnType<typeof detectAndParse>[number]) {
  const crashed = crash.threads.find((thread) => thread.crashed)!;
  return crashed.frames.filter(
    (frame) =>
      frame.imageIndex !== null && crash.images[frame.imageIndex]!.isApp,
  );
}

describe("crash parsers", () => {
  test("reads an .ips report and its image offsets", () => {
    const [crash] = detectAndParse(read("CrashDemo.ips"));
    expect(crash).toMatchObject({
      format: "IPS",
      incidentId: "6DDE6F6E-89DB-41D8-853D-D9D0A0335ACD",
      appName: "CrashDemo",
      exceptionType: "EXC_BREAKPOINT",
      signal: "SIGTRAP",
      crashedThread: 0,
      crashedAt: "2026-09-23T23:54:35.000Z",
      terminationReason: "SIGNAL 5 Trace/BPT trap: 5",
    });
    expect(crash!.images[0]).toMatchObject({
      uuid: APP_UUID,
      base: "0x104da8000",
      isApp: true,
    });
    expect(crash!.images[1]!.isApp).toBe(false);
    // The absolute-address placeholder has an all-zero UUID and no binary.
    expect(crash!.images[3]).toMatchObject({ uuid: null, isApp: false });
    expect(appFrames(crash!).map((frame) => frame.imageOffset)).toEqual([
      "0xd6c",
      "0xb18",
      "0x9c8",
    ]);
    expect(appFrames(crash!)[0]).toMatchObject({
      address: "0x104da8d6c",
      symbol: null,
    });
    // System frames arrive already named by the device.
    expect(crash!.threads[0]!.frames[0]!.symbol).toContain("_assertionFailure");
  });

  test("rejects .ips reports that are not crashes", () => {
    const contents = read("CrashDemo.ips")
      .toString()
      .replace(/"bug_type":\s*"309"/, '"bug_type":"298"');
    expect(() => detectAndParse(Buffer.from(contents))).toThrow("bug_type 298");
  });

  test("reads a text .crash report", () => {
    const [crash] = detectAndParse(read("CrashDemo.crash"));
    expect(crash).toMatchObject({
      format: "CRASH",
      appName: "CrashDemo",
      bundleId: "com.example.CrashDemo",
      appVersion: "2.4.0",
      buildVersion: "512",
      deviceModel: "iPhone17,1",
      osVersion: "iPhone OS 26.0 (23A341)",
      arch: "ARM-64",
      exceptionType: "EXC_BREAKPOINT",
      signal: "SIGTRAP",
      crashedThread: 0,
      crashedAt: "2026-09-20T21:21:33.405Z",
    });
    expect(crash!.applicationSpecificInformation).toEqual([
      "Swift/ContiguousArrayBuffer.swift:692: Fatal error: Index out of range",
    ]);
    expect(crash!.threads.map((thread) => thread.name)).toEqual([
      "Dispatch queue: com.apple.main-thread",
      null,
    ]);
    expect(crash!.images[0]).toMatchObject({ uuid: APP_UUID, arch: "arm64" });
    expect(appFrames(crash!).map((frame) => frame.imageOffset)).toEqual([
      "0xd6c",
      "0xb18",
      "0x9c8",
    ]);
    expect(crash!.threads[0]!.frames[0]).toMatchObject({
      imageName: "libswiftCore.dylib",
      symbol: "_assertionFailure(_:_:file:line:flags:)",
      symbolOffset: 276,
    });
  });

  test("reads symbolicated frames and a legacy exception backtrace", () => {
    const report = [
      "Incident Identifier: 1",
      "Process:             Acme [1]",
      "Exception Type:  EXC_CRASH (SIGABRT)",
      "",
      "Application Specific Information:",
      "*** Terminating app due to uncaught exception 'NSInvalidArgumentException', reason: '-[Foo bar]: unrecognized selector'",
      "",
      "Last Exception Backtrace:",
      "(0x100004010 0x100004020)",
      "",
      "Thread 0 Crashed:",
      "0   Acme Widgets                 	0x0000000100004010 ViewController.buttonTapped(_:) + 16 (ViewController.swift:42)",
      "",
      "Binary Images:",
      "0x100000000 - 0x100007fff Acme Widgets arm64  <11112222333344445555666677778888> /private/var/containers/Bundle/Application/X/Acme.app/Acme Widgets",
    ].join("\n");
    const [crash] = detectAndParse(Buffer.from(report));
    expect(crash!.exceptionReason).toBe("-[Foo bar]: unrecognized selector");
    expect(crash!.threads[0]!.frames[0]).toMatchObject({
      imageName: "Acme Widgets",
      imageOffset: "0x4010",
      symbol: "ViewController.buttonTapped(_:)",
      symbolOffset: 16,
      sourceFile: "ViewController.swift",
      sourceLine: 42,
    });
    expect(
      crash!.lastExceptionBacktrace!.map((frame) => frame.imageOffset),
    ).toEqual(["0x4010", "0x4020"]);
  });

  test("reads MetricKit payloads and corrects load-address offsets", () => {
    const crashes = detectAndParse(read("metrickit-payload.json"));
    expect(crashes).toHaveLength(1);
    const [crash] = crashes;
    expect(crash).toMatchObject({
      format: "METRICKIT",
      bundleId: "com.example.CrashDemo",
      appVersion: "2.4.0",
      buildVersion: "512",
      exceptionType: "EXC_BREAKPOINT",
      signal: "SIGTRAP",
      exceptionCodes: "1",
      arch: "arm64e",
      crashedThread: 0,
      crashedAt: expect.stringMatching(/^2026-09-20T/),
    });
    const app = crash!.images.find((image) => image.uuid === APP_UUID)!;
    expect(app).toMatchObject({
      name: "CrashDemo",
      base: "0x104da8000",
      isApp: true,
      arch: null,
    });
    const swift = crash!.images.find(
      (image) => image.name === "libswiftCore.dylib",
    )!;
    // libswiftCore reported its load address instead of an offset.
    expect(swift).toMatchObject({ base: "0x19489a000", isApp: false });
    expect(crash!.threads[0]!.frames[1]!.imageOffset).toBe("0xf47c");
    expect(appFrames(crash!).map((frame) => frame.imageOffset)).toEqual([
      "0xd6c",
      "0xb18",
      "0x9c8",
    ]);
  });

  test("accepts an array of payloads and a bare diagnostic", () => {
    const payload = JSON.parse(read("metrickit-payload.json").toString());
    expect(
      detectAndParse(Buffer.from(JSON.stringify([payload, payload]))),
    ).toHaveLength(2);
    expect(
      detectAndParse(
        Buffer.from(JSON.stringify(payload.crashDiagnostics[0])),
      )[0]!.format,
    ).toBe("METRICKIT");
  });

  test("names the formats it accepts when it recognizes none", () => {
    expect(() => detectAndParse(Buffer.from("hello"))).toThrow(CrashParseError);
    expect(() => detectAndParse(Buffer.from('{"hello":1}'))).toThrow(
      "neither an .ips report nor a MetricKit payload",
    );
    expect(() => detectAndParse(Buffer.from([0xff, 0xfe, 0x00]))).toThrow(
      "UTF-8",
    );
  });
});
