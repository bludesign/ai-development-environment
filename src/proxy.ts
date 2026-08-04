import { getSessionCookie } from "better-auth/cookies";
import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";

import { routing } from "@/i18n/routing";

const intlMiddleware = createMiddleware(routing);

function localeAndPage(pathname: string): {
  locale: string;
  page: string;
} {
  const segments = pathname.split("/").filter(Boolean);
  const candidate = segments[0];
  const locale = routing.locales.includes(candidate as never)
    ? candidate!
    : routing.defaultLocale;
  return {
    locale,
    page: routing.locales.includes(candidate as never)
      ? (segments[1] ?? "")
      : (segments[0] ?? ""),
  };
}

export default async function proxy(request: NextRequest): Promise<Response> {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const { locale, page } = localeAndPage(pathname);
  const isAuthPage = page === "sign-in" || page === "register";
  const hasOptimisticSession = Boolean(
    getSessionCookie(request) || request.headers.get("authorization"),
  );
  if (!hasOptimisticSession && !isAuthPage) {
    const destination = new URL(`/${locale}/sign-in`, request.url);
    const returnTo = `${pathname}${search}`;
    if (returnTo.startsWith("/") && !returnTo.startsWith("//")) {
      destination.searchParams.set("returnTo", returnTo);
    }
    return NextResponse.redirect(destination);
  }
  if (hasOptimisticSession && isAuthPage) {
    return NextResponse.redirect(new URL(`/${locale}`, request.url));
  }
  return intlMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
