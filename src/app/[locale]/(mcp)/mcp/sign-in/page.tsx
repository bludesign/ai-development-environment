import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import {
  getAuth,
  getAuthRuntimeConfig,
  getRegistrationStatus,
} from "@/services/auth";
import { getMcpOAuthConfig } from "@/services/auth/mcp-oauth-config";
import {
  authorizationContinuation,
  oauthQueryString,
  validMcpOAuthQuery,
} from "@/services/auth/mcp-oauth-query";

export default async function McpSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!getMcpOAuthConfig()) notFound();
  const query = oauthQueryString(await searchParams);
  if (!(await validMcpOAuthQuery(query))) notFound();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (
    session &&
    !new URLSearchParams(query).get("prompt")?.split(" ").includes("login")
  )
    redirect(authorizationContinuation(query));
  const runtime = getAuthRuntimeConfig();
  return (
    <AuthForm
      configuration={{
        mode: runtime.mode,
        registration: await getRegistrationStatus(),
        provider: runtime.provider
          ? {
              id: runtime.provider.providerId,
              name: runtime.provider.displayName,
            }
          : null,
      }}
      intent="sign-in"
      returnTo={`/mcp/sign-in?${query}`}
    />
  );
}
