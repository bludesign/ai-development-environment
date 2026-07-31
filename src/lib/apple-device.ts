/**
 * Apple reports a hardware identifier (`iPhone16,2`) and a software build
 * (`23F84`) through the enrollment profile's `DeviceAttributes`, not the names
 * a person would recognise. Device lists read far better as `iPhone 15 Pro Max`
 * over `26.5`, and neither translation needs a network round trip, so both maps
 * live here rather than behind the IPSW.me lookup the detail page uses for its
 * exact firmware history.
 */

const PRODUCT_NAMES: Record<string, string> = {
  // iPhone
  "iPhone1,1": "iPhone",
  "iPhone1,2": "iPhone 3G",
  "iPhone2,1": "iPhone 3GS",
  "iPhone3,1": "iPhone 4",
  "iPhone3,2": "iPhone 4",
  "iPhone3,3": "iPhone 4",
  "iPhone4,1": "iPhone 4s",
  "iPhone5,1": "iPhone 5",
  "iPhone5,2": "iPhone 5",
  "iPhone5,3": "iPhone 5c",
  "iPhone5,4": "iPhone 5c",
  "iPhone6,1": "iPhone 5s",
  "iPhone6,2": "iPhone 5s",
  "iPhone7,1": "iPhone 6 Plus",
  "iPhone7,2": "iPhone 6",
  "iPhone8,1": "iPhone 6s",
  "iPhone8,2": "iPhone 6s Plus",
  "iPhone8,4": "iPhone SE (1st generation)",
  "iPhone9,1": "iPhone 7",
  "iPhone9,2": "iPhone 7 Plus",
  "iPhone9,3": "iPhone 7",
  "iPhone9,4": "iPhone 7 Plus",
  "iPhone10,1": "iPhone 8",
  "iPhone10,2": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X",
  "iPhone10,4": "iPhone 8",
  "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,6": "iPhone X",
  "iPhone11,2": "iPhone XS",
  "iPhone11,4": "iPhone XS Max",
  "iPhone11,6": "iPhone XS Max",
  "iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11",
  "iPhone12,3": "iPhone 11 Pro",
  "iPhone12,5": "iPhone 11 Pro Max",
  "iPhone12,8": "iPhone SE (2nd generation)",
  "iPhone13,1": "iPhone 12 mini",
  "iPhone13,2": "iPhone 12",
  "iPhone13,3": "iPhone 12 Pro",
  "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,2": "iPhone 13 Pro",
  "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,4": "iPhone 13 mini",
  "iPhone14,5": "iPhone 13",
  "iPhone14,6": "iPhone SE (3rd generation)",
  "iPhone14,7": "iPhone 14",
  "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro",
  "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15",
  "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro",
  "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro",
  "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,3": "iPhone 16",
  "iPhone17,4": "iPhone 16 Plus",
  "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro",
  "iPhone18,2": "iPhone 17 Pro Max",
  "iPhone18,3": "iPhone 17",
  "iPhone18,4": "iPhone Air",

  // iPad
  "iPad6,11": "iPad (5th generation)",
  "iPad6,12": "iPad (5th generation)",
  "iPad7,5": "iPad (6th generation)",
  "iPad7,6": "iPad (6th generation)",
  "iPad7,11": "iPad (7th generation)",
  "iPad7,12": "iPad (7th generation)",
  "iPad8,1": "iPad Pro 11-inch (1st generation)",
  "iPad8,2": "iPad Pro 11-inch (1st generation)",
  "iPad8,3": "iPad Pro 11-inch (1st generation)",
  "iPad8,4": "iPad Pro 11-inch (1st generation)",
  "iPad8,5": "iPad Pro 12.9-inch (3rd generation)",
  "iPad8,6": "iPad Pro 12.9-inch (3rd generation)",
  "iPad8,7": "iPad Pro 12.9-inch (3rd generation)",
  "iPad8,8": "iPad Pro 12.9-inch (3rd generation)",
  "iPad8,9": "iPad Pro 11-inch (2nd generation)",
  "iPad8,10": "iPad Pro 11-inch (2nd generation)",
  "iPad8,11": "iPad Pro 12.9-inch (4th generation)",
  "iPad8,12": "iPad Pro 12.9-inch (4th generation)",
  "iPad11,1": "iPad mini (5th generation)",
  "iPad11,2": "iPad mini (5th generation)",
  "iPad11,3": "iPad Air (3rd generation)",
  "iPad11,4": "iPad Air (3rd generation)",
  "iPad11,6": "iPad (8th generation)",
  "iPad11,7": "iPad (8th generation)",
  "iPad12,1": "iPad (9th generation)",
  "iPad12,2": "iPad (9th generation)",
  "iPad13,1": "iPad Air (4th generation)",
  "iPad13,2": "iPad Air (4th generation)",
  "iPad13,4": "iPad Pro 11-inch (3rd generation)",
  "iPad13,5": "iPad Pro 11-inch (3rd generation)",
  "iPad13,6": "iPad Pro 11-inch (3rd generation)",
  "iPad13,7": "iPad Pro 11-inch (3rd generation)",
  "iPad13,8": "iPad Pro 12.9-inch (5th generation)",
  "iPad13,9": "iPad Pro 12.9-inch (5th generation)",
  "iPad13,10": "iPad Pro 12.9-inch (5th generation)",
  "iPad13,11": "iPad Pro 12.9-inch (5th generation)",
  "iPad13,16": "iPad Air (5th generation)",
  "iPad13,17": "iPad Air (5th generation)",
  "iPad13,18": "iPad (10th generation)",
  "iPad13,19": "iPad (10th generation)",
  "iPad14,1": "iPad mini (6th generation)",
  "iPad14,2": "iPad mini (6th generation)",
  "iPad14,3": "iPad Pro 11-inch (4th generation)",
  "iPad14,4": "iPad Pro 11-inch (4th generation)",
  "iPad14,5": "iPad Pro 12.9-inch (6th generation)",
  "iPad14,6": "iPad Pro 12.9-inch (6th generation)",
  "iPad14,8": "iPad Air 11-inch (M2)",
  "iPad14,9": "iPad Air 11-inch (M2)",
  "iPad14,10": "iPad Air 13-inch (M2)",
  "iPad14,11": "iPad Air 13-inch (M2)",
  "iPad15,3": "iPad Air 11-inch (M3)",
  "iPad15,4": "iPad Air 11-inch (M3)",
  "iPad15,5": "iPad Air 13-inch (M3)",
  "iPad15,6": "iPad Air 13-inch (M3)",
  "iPad15,7": "iPad (A16)",
  "iPad15,8": "iPad (A16)",
  "iPad16,1": "iPad mini (A17 Pro)",
  "iPad16,2": "iPad mini (A17 Pro)",
  "iPad16,3": "iPad Pro 11-inch (M4)",
  "iPad16,4": "iPad Pro 11-inch (M4)",
  "iPad16,5": "iPad Pro 13-inch (M4)",
  "iPad16,6": "iPad Pro 13-inch (M4)",

  // iPod touch
  "iPod5,1": "iPod touch (5th generation)",
  "iPod7,1": "iPod touch (6th generation)",
  "iPod9,1": "iPod touch (7th generation)",
};

const SIMULATOR_ARCHITECTURES = new Set(["arm64", "i386", "x86_64"]);

/**
 * Apple's build numbers start with the Darwin major, which tracked
 * `iOS major + 4` up to iOS 18 (`22A`) and then jumped to the year-based
 * scheme with iOS 26 (`23A`). The letter is the minor: `A` is `.0`, `B` is
 * `.1`, and so on, which is what makes `23F84` read as `26.5`.
 */
const BUILD_PATTERN = /^(\d{2})([A-Z])\d+[a-z]?$/;
const FIRST_YEAR_BASED_DARWIN_MAJOR = 23;
const YEAR_BASED_OFFSET = 3;
const SEQUENTIAL_OFFSET = -4;

/**
 * Turns an Apple hardware identifier into its marketing name — `iPhone16,2`
 * becomes `iPhone 15 Pro Max`. Identifiers Apple shipped after this table was
 * written come back unchanged so the column still says something useful.
 */
export function formatAppleProductName(product: string): string {
  const identifier = product.trim();
  if (!identifier) return identifier;
  const name = PRODUCT_NAMES[identifier];
  if (name) return name;
  return SIMULATOR_ARCHITECTURES.has(identifier)
    ? `Simulator (${identifier})`
    : identifier;
}

/**
 * Turns the software version Apple reports into the version a person reads on
 * the device: the build `23F84` becomes `26.5`, and a value that already names
 * a version keeps its digits without the platform prefix. The build alone does
 * not carry the patch component, so `26.5.2` also reads as `26.5` here; the
 * device detail page resolves the exact version from IPSW.me.
 */
export function formatAppleOsVersion(version: string): string {
  const value = version.trim();
  if (!value) return value;
  const build = BUILD_PATTERN.exec(value);
  if (build) {
    const darwinMajor = Number(build[1]);
    const major =
      darwinMajor +
      (darwinMajor >= FIRST_YEAR_BASED_DARWIN_MAJOR
        ? YEAR_BASED_OFFSET
        : SEQUENTIAL_OFFSET);
    const minor = build[2].charCodeAt(0) - "A".charCodeAt(0);
    return `${major}.${minor}`;
  }
  return value.replace(/^(?:iOS|iPadOS|watchOS|tvOS|visionOS)\s+/i, "");
}
