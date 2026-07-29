/**
 * Freezes the screenshot-only Next.js server at SCREENSHOT_TIME.
 *
 * Keep native timers running: screenshot routes still need normal network and timeout
 * behaviour. Reusing Date.prototype also keeps dates returned by native modules compatible
 * with `instanceof Date` checks after the constructor is replaced.
 */
const NativeDate = globalThis.Date;
const fixedTime = process.env.SCREENSHOT_TIME;
const fixedTimestamp = NativeDate.parse(fixedTime ?? "");

if (!Number.isFinite(fixedTimestamp)) {
  throw new Error("SCREENSHOT_TIME must contain a valid date-time");
}

function FixedDate(...args) {
  if (!new.target) return new NativeDate(fixedTimestamp).toString();
  if (args.length === 0) return new NativeDate(fixedTimestamp);
  return new NativeDate(...args);
}

Object.setPrototypeOf(FixedDate, NativeDate);
FixedDate.prototype = NativeDate.prototype;
FixedDate.now = () => fixedTimestamp;
// Keep these as own properties too. Next.js copies selected globals into request contexts, and
// inherited Date statics can otherwise disappear even though they work in the parent process.
for (const property of ["parse", "UTC"]) {
  Object.defineProperty(
    FixedDate,
    property,
    Object.getOwnPropertyDescriptor(NativeDate, property),
  );
}

globalThis.Date = FixedDate;
