import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { McpConsentForm } from "@/components/auth/mcp-consent-form";
import { getAuth } from "@/services/auth/auth";
import { getMcpOAuthConfig } from "@/services/auth/mcp-oauth-config";
import {
  oauthQueryString,
  validMcpOAuthQuery,
} from "@/services/auth/mcp-oauth-query";

export default async function McpConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!getMcpOAuthConfig()) notFound();
  const query = oauthQueryString(await searchParams);
  if (!(await validMcpOAuthQuery(query))) notFound();
  const params = new URLSearchParams(query);
  const clientId = params.get("client_id");
  if (!clientId) notFound();
  const requestHeaders = await headers();
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session)
    redirect(
      `/sign-in?returnTo=${encodeURIComponent(`/mcp/consent?${query}`)}`,
    );
  const client = await auth.api.getOAuthClientPublic({
    headers: requestHeaders,
    query: { client_id: clientId },
  });
  return (
    <McpConsentForm
      clientId={clientId}
      clientName={client.client_name ?? clientId}
      oauthQuery={query}
      requestedScopes={(params.get("scope") ?? "mcp:read")
        .split(/\s+/)
        .filter(Boolean)}
    />
  );
}
