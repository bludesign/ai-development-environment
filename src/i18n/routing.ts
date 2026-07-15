import { defineRouting } from "next-intl/routing";

export const locales = ["en", "es", "fr", "de"] as const;

export const routing = defineRouting({
  locales,
  defaultLocale: "en",
  // Prefixing the default locale avoids a production standalone rewrite through Next's
  // internal `localhost` origin; unprefixed routes redirect once to their stable locale URL.
  localePrefix: "always",
});
