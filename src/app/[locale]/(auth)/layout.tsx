import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "@/services/auth";

export default async function AuthLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const [{ locale }, requestHeaders, auth] = await Promise.all([
    params,
    headers(),
    getAuth(),
  ]);
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (session) redirect(`/${locale}`);

  return children;
}
