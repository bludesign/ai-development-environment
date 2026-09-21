import type { GenericOAuthUserInfo } from "better-auth/plugins";

type GitHubProfile = {
  avatar_url?: unknown;
  email?: unknown;
  login?: unknown;
  name?: unknown;
  [key: string]: unknown;
};

type GitHubEmail = {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emailEndpoint(userInfoUrl: string): string {
  const endpoint = new URL(userInfoUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/emails`;
  return endpoint.toString();
}

async function githubRequest(
  url: string,
  accessToken: string,
): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "AI-Development-Environment",
      },
    });
  } catch {
    return null;
  }
}

/**
 * GitHub omits private addresses from `/user`, even with the `user:email`
 * scope. Better Auth's built-in GitHub provider compensates by querying
 * `/user/emails`; the generic OAuth provider does not, so do the same here
 * without changing this application's generic OAuth callback contract.
 */
export async function fetchGitHubProfile(
  userInfoUrl: string,
  accessToken: string,
): Promise<GenericOAuthUserInfo | null> {
  const profileResponse = await githubRequest(userInfoUrl, accessToken);
  if (!profileResponse?.ok) return null;

  const profile = (await profileResponse.json()) as GitHubProfile;
  const profileEmail = stringValue(profile.email);

  const emailsResponse = await githubRequest(
    emailEndpoint(userInfoUrl),
    accessToken,
  );
  const emailPayload = emailsResponse?.ok ? await emailsResponse.json() : [];
  const emails = Array.isArray(emailPayload)
    ? (emailPayload as GitHubEmail[])
    : [];
  const selectedEmail =
    emails.find((email) => email.primary === true) ?? emails[0];
  const email = profileEmail ?? stringValue(selectedEmail?.email);
  const matchingEmail = emails.find(
    (candidate) => stringValue(candidate.email) === email,
  );

  return {
    ...profile,
    email,
    emailVerified: matchingEmail?.verified === true,
    image: stringValue(profile.avatar_url),
    name: stringValue(profile.name) ?? stringValue(profile.login) ?? "",
  };
}
