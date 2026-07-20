import { describe, expect, test, vi } from "vitest";

import { fetchIpswDevice, parseIpswDevice } from "./ipsw";

const response = {
  name: "iPhone 11",
  identifier: "iPhone12,1",
  firmwares: [
    {
      identifier: "iPhone12,1",
      version: "26.5",
      buildid: "23F77",
      filesize: 9_750_215_662,
      url: "https://updates.cdn-apple.com/iPhone12,1_26.5_23F77.ipsw",
      releasedate: "2026-05-11T17:47:45Z",
      signed: false,
    },
    {
      identifier: "iPhone12,1",
      version: "26.5.2",
      buildid: "23F84",
      filesize: 9_750_283_647,
      url: "https://updates.cdn-apple.com/iPhone12,1_26.5.2_23F84.ipsw",
      releasedate: "2026-06-29T17:41:13Z",
      signed: true,
    },
  ],
};

describe("IPSW.me device firmware", () => {
  test("normalizes firmware fields and sorts newest releases first", () => {
    expect(parseIpswDevice(response, "iPhone12,1")).toEqual({
      name: "iPhone 11",
      identifier: "iPhone12,1",
      firmwares: [
        {
          version: "26.5.2",
          buildId: "23F84",
          fileSize: 9_750_283_647,
          url: "https://updates.cdn-apple.com/iPhone12,1_26.5.2_23F84.ipsw",
          releaseDate: "2026-06-29T17:41:13.000Z",
          signed: true,
        },
        {
          version: "26.5",
          buildId: "23F77",
          fileSize: 9_750_215_662,
          url: "https://updates.cdn-apple.com/iPhone12,1_26.5_23F77.ipsw",
          releaseDate: "2026-05-11T17:47:45.000Z",
          signed: false,
        },
      ],
    });
  });

  test("requests only a validated device identifier", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(response), { status: 200 }),
      );
    await expect(
      fetchIpswDevice("iPhone12,1", fetcher as typeof fetch),
    ).resolves.toMatchObject({ name: "iPhone 11" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.ipsw.me/v4/device/iPhone12%2C1",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );

    await expect(
      fetchIpswDevice("../../other", fetcher as typeof fetch),
    ).rejects.toThrow("identifier is invalid");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("rejects mismatched devices and unsafe download URLs", () => {
    expect(() =>
      parseIpswDevice({ ...response, identifier: "iPhone13,1" }, "iPhone12,1"),
    ).toThrow("different device");
    expect(() =>
      parseIpswDevice(
        {
          ...response,
          firmwares: [
            {
              ...response.firmwares[0],
              url: "http://updates.example.com/restore.ipsw",
            },
          ],
        },
        "iPhone12,1",
      ),
    ).toThrow("insecure firmware URL");
  });

  test("maps upstream failures without returning response bodies", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("upstream secret", {
        status: 503,
      }),
    );
    await expect(
      fetchIpswDevice("iPhone12,1", fetcher as typeof fetch),
    ).rejects.toThrow("IPSW.me returned HTTP 503");
  });
});
