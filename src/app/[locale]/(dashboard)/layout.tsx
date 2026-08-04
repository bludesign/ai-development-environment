import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { getAuth } from "@/services/auth";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";

export default async function DashboardLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const [{ locale }, requestHeaders, cookieStore, auth] = await Promise.all([
    params,
    headers(),
    cookies(),
    getAuth(),
  ]);
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect(`/${locale}/sign-in`);

  return (
    <AppShell
      currentUser={{
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
      }}
      leftDefaultOpen={cookieStore.get(LEFT_SIDEBAR_COOKIE)?.value !== "false"}
      rightDefaultOpen={
        cookieStore.get(RIGHT_SIDEBAR_COOKIE)?.value !== "false"
      }
    >
      {children}
    </AppShell>
  );
}
