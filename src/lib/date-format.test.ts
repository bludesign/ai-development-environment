import { describe, expect, it } from "vitest";

import {
  DATE_FALLBACK,
  formatDateValue,
  formatRelativeTime,
  formatUtcMillis,
  isSameDay,
  toDate,
} from "./date-format";

// 2026-07-22T07:01:37.143Z — 03:01 in America/New_York, which the vitest run pins via TZ.
const SAMPLE = "2026-07-22T07:01:37.143Z";
const LOCALE = "en-US";

describe("toDate", () => {
  it("returns null for empty and unparseable input", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate("not a date")).toBeNull();
  });

  it("accepts strings, epoch millis, and Date instances", () => {
    const expected = Date.parse(SAMPLE);
    expect(toDate(SAMPLE)?.getTime()).toBe(expected);
    expect(toDate(expected)?.getTime()).toBe(expected);
    expect(toDate(new Date(SAMPLE))?.getTime()).toBe(expected);
  });
});

describe("formatDateValue", () => {
  it("renders the four kinds in UTC with a 12-hour clock", () => {
    const options = { locale: LOCALE, utc: true };
    expect(formatDateValue(SAMPLE, "long", options)).toBe(
      "Wednesday, July 22, 2026 at 7:01:37 AM",
    );
    expect(formatDateValue(SAMPLE, "short", options)).toBe(
      "Jul 22, 2026, 7:01:37 AM",
    );
    expect(formatDateValue(SAMPLE, "time", options)).toBe("7:01:37 AM");
  });

  it("drops the time when showTime is false", () => {
    const options = { locale: LOCALE, utc: true, showTime: false };
    expect(formatDateValue(SAMPLE, "long", options)).toBe(
      "Wednesday, July 22, 2026",
    );
    expect(formatDateValue(SAMPLE, "short", options)).toBe("Jul 22, 2026");
  });

  it("switches to a 24-hour clock", () => {
    const options = { locale: LOCALE, utc: true, hour12: false };
    expect(formatDateValue(SAMPLE, "long", options)).toBe(
      "Wednesday, July 22, 2026 at 07:01:37",
    );
    expect(formatDateValue(SAMPLE, "short", options)).toBe(
      "Jul 22, 2026, 07:01:37",
    );
    expect(formatDateValue(SAMPLE, "time", options)).toBe("07:01:37");
  });

  it("defaults to short and to a 12-hour clock", () => {
    expect(
      formatDateValue(SAMPLE, undefined, { locale: LOCALE, utc: true }),
    ).toBe("Jul 22, 2026, 7:01:37 AM");
  });

  it("honours the locale", () => {
    expect(
      formatDateValue(SAMPLE, "short", {
        locale: "de",
        utc: true,
        hour12: false,
      }),
    ).toBe("22.07.2026, 07:01:37");
  });

  // Forcing a 12-hour clock onto a 24-hour locale is imperfect — Intl keeps the
  // padded hour and appends an English meridiem. Pinned so the quirk is a known
  // consequence of the 12-hour default rather than a surprise.
  it("forces a 12-hour clock even on 24-hour locales", () => {
    expect(formatDateValue(SAMPLE, "short", { locale: "de", utc: true })).toBe(
      "22.07.2026, 07:01:37 AM",
    );
  });

  it("formats in the viewer's zone unless utc is set", () => {
    const local = formatDateValue(SAMPLE, "time", { locale: LOCALE });
    const utc = formatDateValue(SAMPLE, "time", { locale: LOCALE, utc: true });
    expect(local).not.toBe(utc);
    expect(utc).toBe("7:01:37 AM");
  });

  it("falls back for missing values", () => {
    expect(formatDateValue(null)).toBe(DATE_FALLBACK);
    expect(formatDateValue("nonsense")).toBe(DATE_FALLBACK);
    expect(formatDateValue(null, "short", { fallback: "Never" })).toBe("Never");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse(SAMPLE);
  const ago = (ms: number) =>
    formatRelativeTime(new Date(now - ms), LOCALE, now);

  it("walks the unit cascade", () => {
    expect(ago(5_000)).toBe("5 seconds ago");
    expect(ago(90_000)).toBe("1 minute ago");
    expect(ago(9 * 3_600_000)).toBe("9 hours ago");
    expect(ago(3 * 86_400_000)).toBe("3 days ago");
    expect(ago(14 * 86_400_000)).toBe("2 weeks ago");
    expect(ago(60 * 86_400_000)).toBe("2 months ago");
    expect(ago(400 * 86_400_000)).toBe("last year");
  });

  it("handles future timestamps", () => {
    expect(formatRelativeTime(new Date(now + 9 * 3_600_000), LOCALE, now)).toBe(
      "in 9 hours",
    );
  });

  it("switches unit at each boundary", () => {
    expect(ago(59_400)).toBe("59 seconds ago");
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(3_540_000)).toBe("59 minutes ago");
    expect(ago(3_600_000)).toBe("1 hour ago");
  });

  // The elapsed span is rounded to whole seconds before the cascade runs, so
  // the seam sits just under the unit rather than exactly on it.
  it("rounds to whole seconds before choosing a unit", () => {
    expect(ago(59_500)).toBe("59 seconds ago");
    expect(ago(59_501)).toBe("1 minute ago");
  });

  it("is reachable through formatDateValue", () => {
    expect(
      formatDateValue(now - 9 * 3_600_000, "relative", { locale: LOCALE, now }),
    ).toBe("9 hours ago");
  });
});

describe("isSameDay", () => {
  it("compares calendar days, not elapsed time", () => {
    expect(
      isSameDay("2026-07-22T00:00:01Z", "2026-07-22T23:59:59Z", {
        utc: true,
      }),
    ).toBe(true);
    // Under two hours apart, but either side of midnight.
    expect(
      isSameDay("2026-07-22T23:30:00Z", "2026-07-23T00:30:00Z", {
        utc: true,
      }),
    ).toBe(false);
  });

  it("resolves the day in the requested zone", () => {
    // 23:30 UTC on the 22nd is still the 22nd in UTC but the 23rd in Tokyo.
    const late = "2026-07-22T23:30:00Z";
    const next = "2026-07-23T02:00:00Z";
    expect(isSameDay(late, next, { utc: true })).toBe(false);
    expect(isSameDay(late, next, { timeZone: "Asia/Tokyo" })).toBe(true);
  });

  it("accepts epoch millis and Date instances", () => {
    const value = Date.parse(SAMPLE);
    expect(isSameDay(value, new Date(value), { utc: true })).toBe(true);
  });

  it("is false when either side is missing", () => {
    expect(isSameDay(null, SAMPLE)).toBe(false);
    expect(isSameDay(SAMPLE, "nonsense")).toBe(false);
  });
});

describe("formatUtcMillis", () => {
  it("renders 24-hour UTC time with milliseconds", () => {
    expect(formatUtcMillis(SAMPLE, LOCALE)).toBe("07:01:37.143");
  });

  it("is unaffected by the viewer's zone", () => {
    expect(formatUtcMillis("2026-07-22T23:01:37.143Z", LOCALE)).toBe(
      "23:01:37.143",
    );
  });

  it("falls back for missing values", () => {
    expect(formatUtcMillis(null)).toBe(DATE_FALLBACK);
  });
});
