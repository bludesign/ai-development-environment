import "server-only";

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";

import { importPKCS8, SignJWT } from "jose";

const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "ai-development-environment";
const TOKEN_REFRESH_CUSHION_MS = 5 * 60 * 1000;

export type GitHubAppErrorCode =
  | "ACTIONS_PERMISSION_REQUIRED"
  | "APP_INSTALLATION_MISMATCH"
  | "CHECK_SUITE_NOT_FOUND"
  | "CHECK_SUITE_REPOSITORY_MISMATCH"
  | "GITHUB_APP_NOT_CONFIGURED"
  | "GITHUB_APP_REQUEST_FAILED"
  | "GITHUB_APP_UNAUTHORIZED"
  | "INSTALLATION_NOT_FOUND"
  | "INVALID_APP_ID"
  | "INVALID_INSTALLATION_ID"
  | "INVALID_PRIVATE_KEY"
  | "NOT_GITHUB_ACTIONS"
  | "REPOSITORY_NOT_INSTALLED"
  | "WORKFLOW_NOT_COMPLETED"
  | "WORKFLOW_RUN_UNAVAILABLE";

export class GitHubAppError extends Error {
  constructor(
    public readonly code: GitHubAppErrorCode,
    message: string,
    public readonly githubRequestId: string | null = null,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

export type GitHubAppCredentials = {
  appId: string;
  installationId: string;
  privateKey: string;
  apiBaseUrl: string;
  graphqlUrl: string;
  keyFingerprint?: string;
};

export type GitHubAppVerification = {
  appId: string;
  installationId: string;
  keyFingerprint: string;
  appSlug: string;
  accountLogin: string;
  repositorySelection: "all" | "selected";
  actionsPermission: string;
  viewerLogin: string;
  verifiedAt: Date;
  githubRequestId: string | null;
};

type PreparedCredentials = GitHubAppCredentials & {
  privateKeyPkcs8: string;
  keyFingerprint: string;
};

type InstallationToken = {
  token: string;
  expiresAt: Date;
  permissions: Record<string, string>;
  repositorySelection: "all" | "selected";
};

type InstallationDetails = {
  id: number;
  app_id: number;
  app_slug: string;
  account: { login: string };
  repository_selection: "all" | "selected";
};

type InstallationTokenResponse = {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: "all" | "selected";
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

const tokenCache = new Map<string, InstallationToken>();
const tokenRefreshes = new Map<string, Promise<InstallationToken>>();

function validateIdentifier(
  value: string,
  label: string,
  code: "INVALID_APP_ID" | "INVALID_INSTALLATION_ID",
): string {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new GitHubAppError(code, `${label} must be a positive integer`);
  }
  return normalized;
}

function parsePrivateKey(privateKeyPem: string): {
  key: KeyObject;
  privateKeyPkcs8: string;
  keyFingerprint: string;
} {
  try {
    const key = createPrivateKey({
      key: privateKeyPem.trim(),
      format: "pem",
    });
    if (key.asymmetricKeyType !== "rsa") {
      throw new Error("The key is not RSA");
    }
    const privateKeyPkcs8 = key
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const publicKey = createPublicKey(key).export({
      format: "der",
      type: "spki",
    });
    const keyFingerprint = `SHA256:${createHash("sha256")
      .update(publicKey)
      .digest("base64url")}`;
    return { key, privateKeyPkcs8, keyFingerprint };
  } catch {
    throw new GitHubAppError(
      "INVALID_PRIVATE_KEY",
      "The GitHub App private key is not a valid RSA PEM",
    );
  }
}

export function prepareGitHubAppCredentials(
  input: GitHubAppCredentials,
): PreparedCredentials {
  const { privateKeyPkcs8, keyFingerprint } = parsePrivateKey(input.privateKey);
  return {
    ...input,
    appId: validateIdentifier(input.appId, "GitHub App ID", "INVALID_APP_ID"),
    installationId: validateIdentifier(
      input.installationId,
      "GitHub installation ID",
      "INVALID_INSTALLATION_ID",
    ),
    privateKeyPkcs8,
    keyFingerprint,
  };
}

async function createAppJwt(prepared: PreparedCredentials): Promise<string> {
  try {
    const key = await importPKCS8(prepared.privateKeyPkcs8, "RS256");
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(prepared.appId)
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .sign(key);
  } catch {
    throw new GitHubAppError(
      "INVALID_PRIVATE_KEY",
      "The GitHub App private key could not sign an App JWT",
    );
  }
}

function cacheKey(credentials: PreparedCredentials): string {
  return `${credentials.appId}:${credentials.installationId}:${credentials.keyFingerprint}`;
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new GitHubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "GitHub could not be reached",
    );
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function requestId(response: Response): string | null {
  return response.headers.get("x-github-request-id");
}

function responseMessage(
  body: unknown,
  status: number,
  secrets: Array<string | undefined> = [],
): string {
  let message = `GitHub returned HTTP ${status}`;
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    message = body.message;
  }
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return message;
}

async function installationDetails(
  prepared: PreparedCredentials,
  appJwt: string,
): Promise<InstallationDetails> {
  const response = await githubFetch(
    `${prepared.apiBaseUrl}/app/installations/${prepared.installationId}`,
    { headers: githubHeaders(`Bearer ${appJwt}`) },
  );
  const body = await responseBody(response);
  const githubRequestId = requestId(response);
  if (response.status === 401) {
    throw new GitHubAppError(
      "GITHUB_APP_UNAUTHORIZED",
      "GitHub rejected the App ID or private key",
      githubRequestId,
    );
  }
  if (response.status === 404) {
    throw new GitHubAppError(
      "INSTALLATION_NOT_FOUND",
      "The GitHub App installation was not found",
      githubRequestId,
    );
  }
  if (!response.ok || !body || typeof body !== "object") {
    throw new GitHubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      responseMessage(body, response.status, [
        appJwt,
        prepared.privateKey,
        prepared.privateKeyPkcs8,
      ]),
      githubRequestId,
    );
  }
  const details = body as InstallationDetails;
  if (String(details.app_id) !== prepared.appId) {
    throw new GitHubAppError(
      "APP_INSTALLATION_MISMATCH",
      "The installation does not belong to the configured GitHub App",
      githubRequestId,
    );
  }
  return details;
}

async function mintInstallationToken(
  prepared: PreparedCredentials,
  appJwt?: string,
): Promise<InstallationToken> {
  const jwt = appJwt ?? (await createAppJwt(prepared));
  const response = await githubFetch(
    `${prepared.apiBaseUrl}/app/installations/${prepared.installationId}/access_tokens`,
    {
      method: "POST",
      headers: githubHeaders(`Bearer ${jwt}`),
    },
  );
  const body = await responseBody(response);
  const githubRequestId = requestId(response);
  if (response.status === 401) {
    throw new GitHubAppError(
      "GITHUB_APP_UNAUTHORIZED",
      "GitHub rejected the App ID or private key",
      githubRequestId,
    );
  }
  if (response.status === 404) {
    throw new GitHubAppError(
      "INSTALLATION_NOT_FOUND",
      "The GitHub App installation was not found",
      githubRequestId,
    );
  }
  if (!response.ok || !body || typeof body !== "object") {
    throw new GitHubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      responseMessage(body, response.status, [
        jwt,
        prepared.privateKey,
        prepared.privateKeyPkcs8,
      ]),
      githubRequestId,
    );
  }
  const token = body as InstallationTokenResponse;
  if (
    typeof token.token !== "string" ||
    !token.token ||
    typeof token.expires_at !== "string" ||
    Number.isNaN(Date.parse(token.expires_at))
  ) {
    throw new GitHubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      "GitHub returned an invalid installation token response",
      githubRequestId,
    );
  }
  const actionsPermission = token.permissions?.actions ?? "none";
  if (actionsPermission !== "write") {
    throw new GitHubAppError(
      "ACTIONS_PERMISSION_REQUIRED",
      "The GitHub App installation must grant Actions: read and write",
      githubRequestId,
    );
  }
  return {
    token: token.token,
    expiresAt: new Date(token.expires_at),
    permissions: token.permissions ?? {},
    repositorySelection: token.repository_selection ?? "selected",
  };
}

async function getInstallationToken(
  prepared: PreparedCredentials,
): Promise<InstallationToken> {
  const key = cacheKey(prepared);
  const cached = tokenCache.get(key);
  if (
    cached &&
    cached.expiresAt.getTime() - TOKEN_REFRESH_CUSHION_MS > Date.now()
  ) {
    return cached;
  }
  const activeRefresh = tokenRefreshes.get(key);
  if (activeRefresh) return activeRefresh;
  const refresh = mintInstallationToken(prepared)
    .then((token) => {
      tokenCache.set(key, token);
      return token;
    })
    .finally(() => tokenRefreshes.delete(key));
  tokenRefreshes.set(key, refresh);
  return refresh;
}

export function clearGitHubAppTokenCache(): void {
  tokenCache.clear();
  tokenRefreshes.clear();
}

async function withInstallationToken(
  credentials: GitHubAppCredentials,
  request: (token: string) => Promise<Response>,
): Promise<{ response: Response; token: string }> {
  const prepared = prepareGitHubAppCredentials(credentials);
  let installationToken = await getInstallationToken(prepared);
  let response = await request(installationToken.token);
  if (response.status === 401) {
    tokenCache.delete(cacheKey(prepared));
    installationToken = await getInstallationToken(prepared);
    response = await request(installationToken.token);
  }
  return { response, token: installationToken.token };
}

export async function githubAppGraphql<T>(
  credentials: GitHubAppCredentials,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data: T; githubRequestId: string | null }> {
  const requestResult = await withInstallationToken(credentials, (token) =>
    githubFetch(credentials.graphqlUrl, {
      method: "POST",
      headers: {
        ...githubHeaders(`Bearer ${token}`),
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }),
  );
  const { response, token } = requestResult;
  const body = (await responseBody(response)) as GraphQLResponse<T> | null;
  const githubRequestId = requestId(response);
  if (response.status === 401) {
    throw new GitHubAppError(
      "GITHUB_APP_UNAUTHORIZED",
      "GitHub rejected the installation access token",
      githubRequestId,
    );
  }
  if (!response.ok || body?.errors?.length || !body?.data) {
    const message =
      body?.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join("; ") || responseMessage(body, response.status, [token]);
    throw new GitHubAppError(
      "GITHUB_APP_REQUEST_FAILED",
      responseMessage({ message }, response.status, [
        token,
        credentials.privateKey,
      ]),
      githubRequestId,
    );
  }
  return { data: body.data, githubRequestId };
}

export async function verifyGitHubAppConfiguration(
  credentials: GitHubAppCredentials,
): Promise<GitHubAppVerification> {
  const prepared = prepareGitHubAppCredentials(credentials);
  const appJwt = await createAppJwt(prepared);
  const details = await installationDetails(prepared, appJwt);
  const token = await mintInstallationToken(prepared, appJwt);
  tokenCache.set(cacheKey(prepared), token);

  const result = await githubAppGraphql<{ viewer: { login: string } }>(
    prepared,
    "query VerifyGitHubApp { viewer { login } }",
    {},
  );
  return {
    appId: prepared.appId,
    installationId: prepared.installationId,
    keyFingerprint: prepared.keyFingerprint,
    appSlug: details.app_slug,
    accountLogin: details.account.login,
    repositorySelection: token.repositorySelection,
    actionsPermission: token.permissions.actions ?? "none",
    viewerLogin: result.data.viewer.login,
    verifiedAt: new Date(),
    githubRequestId: result.githubRequestId,
  };
}

export async function rerunGitHubActionsWorkflow(
  credentials: GitHubAppCredentials,
  input: { owner: string; repository: string; workflowRunId: string },
): Promise<{ githubRequestId: string | null }> {
  const url = `${credentials.apiBaseUrl}/repos/${encodeURIComponent(
    input.owner,
  )}/${encodeURIComponent(input.repository)}/actions/runs/${encodeURIComponent(
    input.workflowRunId,
  )}/rerun`;
  const requestResult = await withInstallationToken(credentials, (token) =>
    githubFetch(url, {
      method: "POST",
      headers: githubHeaders(`Bearer ${token}`),
    }),
  );
  const { response, token } = requestResult;
  const githubRequestId = requestId(response);
  if (response.status === 401) {
    throw new GitHubAppError(
      "GITHUB_APP_UNAUTHORIZED",
      "GitHub rejected the installation access token",
      githubRequestId,
    );
  }
  if (!response.ok) {
    const body = await responseBody(response);
    throw new GitHubAppError(
      response.status === 404
        ? "REPOSITORY_NOT_INSTALLED"
        : "GITHUB_APP_REQUEST_FAILED",
      response.status === 404
        ? "The repository or workflow run is not available to this installation"
        : responseMessage(body, response.status, [
            token,
            credentials.privateKey,
          ]),
      githubRequestId,
    );
  }
  return { githubRequestId };
}
