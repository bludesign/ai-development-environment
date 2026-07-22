// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";

import { decodeJwt, decodeProtectedHeader } from "jose";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  cancelGitHubActionsWorkflow,
  clearGitHubAppTokenCache,
  configureGitHubAppWebhook,
  githubAppGraphql,
  GitHubAppError,
  listGitHubActionsWorkflowJobs,
  rerunGitHubActionsJob,
  rerunGitHubActionsFailedJobs,
  rerunGitHubActionsWorkflow,
  verifyGitHubAppConfiguration,
} from "./github-app";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

const credentials = {
  appId: "123",
  installationId: "456",
  privateKey: pkcs1,
  apiBaseUrl: "https://api.github.com",
  graphqlUrl: "https://api.github.com/graphql",
};

function response(
  data: unknown,
  status = 200,
  requestId = "REQUEST-1",
): Response {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "x-github-request-id": requestId,
    },
  });
}

function tokenResponse(token = "installation-token") {
  return response({
    token,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    permissions: { actions: "write", metadata: "read" },
    repository_selection: "selected",
  });
}

beforeEach(() => {
  clearGitHubAppTokenCache();
  vi.unstubAllGlobals();
});

describe("GitHub App authentication", () => {
  test("treats GitHub's 404 as a disabled App webhook", async () => {
    const fetchMock = vi.fn(async () =>
      response({ message: "Not Found" }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      configureGitHubAppWebhook(credentials, {
        url: "https://control.example/api/public/github/webhook",
        secret: "webhook-secret",
      }),
    ).resolves.toEqual({ configured: false, githubRequestId: "REQUEST-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app/hook/config",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  test.each([
    ["PKCS#1", pkcs1],
    ["PKCS#8", pkcs8],
  ])("verifies %s keys and signs a short-lived App JWT", async (_name, pem) => {
    let appJwt = "";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/app/installations/456")) {
        appJwt = String(
          (init?.headers as Record<string, string>).authorization,
        ).slice("Bearer ".length);
        return response({
          id: 456,
          app_id: 123,
          app_slug: "workflow-rerunner",
          account: { login: "acme" },
          repository_selection: "selected",
        });
      }
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.endsWith("/graphql")) {
        return response({ data: { viewer: { login: "rerunner[bot]" } } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifyGitHubAppConfiguration({ ...credentials, privateKey: pem }),
    ).resolves.toMatchObject({
      appId: "123",
      installationId: "456",
      appSlug: "workflow-rerunner",
      accountLogin: "acme",
      actionsPermission: "write",
      viewerLogin: "rerunner[bot]",
    });
    expect(decodeProtectedHeader(appJwt)).toMatchObject({ alg: "RS256" });
    const claims = decodeJwt(appJwt);
    expect(claims.iss).toBe("123");
    expect(Number(claims.exp) - Number(claims.iat)).toBe(600);
    expect(
      fetchMock.mock.calls.every(
        ([, init]) =>
          (init?.headers as Record<string, string>)["x-github-api-version"] ===
          "2022-11-28",
      ),
    ).toBe(true);
  });

  test("deduplicates token refreshes and refreshes once after a 401", async () => {
    let tokenMints = 0;
    let graphQlCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/access_tokens")) {
        tokenMints += 1;
        return tokenResponse(`installation-token-${tokenMints}`);
      }
      if (url.endsWith("/graphql")) {
        graphQlCalls += 1;
        const authorization = (init?.headers as Record<string, string>)
          .authorization;
        if (authorization === "Bearer installation-token-1") {
          return response({ message: "expired" }, 401);
        }
        return response({ data: { viewer: { login: "rerunner[bot]" } } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      githubAppGraphql<{ viewer: { login: string } }>(
        credentials,
        "query { viewer { login } }",
        {},
      ),
      githubAppGraphql<{ viewer: { login: string } }>(
        credentials,
        "query { viewer { login } }",
        {},
      ),
    ]);
    expect(first.data.viewer.login).toBe("rerunner[bot]");
    expect(second.data.viewer.login).toBe("rerunner[bot]");
    expect(tokenMints).toBe(2);
    expect(graphQlCalls).toBe(4);

    await githubAppGraphql(credentials, "query { viewer { login } }", {});
    expect(tokenMints).toBe(2);
  });

  test("refreshes a cached token inside the expiry cushion", async () => {
    let tokenMints = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/access_tokens")) {
          tokenMints += 1;
          return response({
            token: `short-token-${tokenMints}`,
            expires_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
            permissions: { actions: "write" },
            repository_selection: "selected",
          });
        }
        return response({ data: { viewer: { login: "rerunner[bot]" } } });
      }),
    );

    await githubAppGraphql(credentials, "query { viewer { login } }", {});
    await githubAppGraphql(credentials, "query { viewer { login } }", {});
    expect(tokenMints).toBe(2);
  });

  test("rejects installations without Actions write permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/app/installations/456")) {
          return response({
            id: 456,
            app_id: 123,
            app_slug: "workflow-rerunner",
            account: { login: "acme" },
            repository_selection: "selected",
          });
        }
        return response({
          token: "read-only-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          permissions: { actions: "read" },
          repository_selection: "selected",
        });
      }),
    );

    await expect(
      verifyGitHubAppConfiguration(credentials),
    ).rejects.toMatchObject({ code: "ACTIONS_PERMISSION_REQUIRED" });
  });

  test("redacts tokens and private keys from GitHub failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/access_tokens"))
          return tokenResponse("secret-token");
        return response(
          { message: `rejected secret-token ${pkcs1}` },
          403,
          "RERUN-1",
        );
      }),
    );

    let caught: unknown;
    try {
      await rerunGitHubActionsWorkflow(credentials, {
        owner: "acme",
        repository: "widgets",
        workflowRunId: "987",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubAppError);
    expect((caught as Error).message).toContain("[REDACTED]");
    expect((caught as Error).message).not.toContain("secret-token");
    expect((caught as Error).message).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  test("reruns only failed jobs through the workflow endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.endsWith("/actions/runs/987/rerun-failed-jobs")) {
        expect(init?.method).toBe("POST");
        return response(null, 201, "FAILED-JOBS-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      rerunGitHubActionsFailedJobs(credentials, {
        owner: "acme",
        repository: "widgets",
        workflowRunId: "987",
      }),
    ).resolves.toEqual({ githubRequestId: "FAILED-JOBS-1" });
  });

  test.each([
    [false, "cancel"],
    [true, "force-cancel"],
  ])(
    "sends force=%s workflow cancellation to the %s endpoint",
    async (force, operation) => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/access_tokens")) return tokenResponse();
        if (url.endsWith(`/actions/runs/987/${operation}`)) {
          expect(init?.method).toBe("POST");
          expect((init?.headers as Record<string, string>).authorization).toBe(
            "Bearer installation-token",
          );
          return response(null, 202, "CANCEL-1");
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        cancelGitHubActionsWorkflow(credentials, {
          owner: "acme",
          repository: "widgets",
          workflowRunId: "987",
          force,
        }),
      ).resolves.toEqual({ githubRequestId: "CANCEL-1" });
    },
  );

  test("lists workflow jobs with the installation token", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/actions/runs/987/jobs")) {
        expect((init?.headers as Record<string, string>).authorization).toBe(
          "Bearer installation-token",
        );
        return response({
          total_count: 1,
          jobs: [
            {
              id: 11,
              name: "test",
              status: "completed",
              conclusion: "success",
              html_url:
                "https://github.com/acme/widgets/actions/runs/987/job/11",
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listGitHubActionsWorkflowJobs(credentials, {
        owner: "acme",
        repository: "widgets",
        workflowRunId: "987",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 11, name: "test" })]);
  });

  test("verifies a job belongs to the workflow run before rerunning it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.endsWith("/actions/jobs/11")) {
        return response({ id: 11, run_id: 987, status: "completed" });
      }
      if (url.endsWith("/actions/jobs/11/rerun")) {
        expect(init?.method).toBe("POST");
        return response(null, 201, "JOB-RERUN-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      rerunGitHubActionsJob(credentials, {
        owner: "acme",
        repository: "widgets",
        workflowRunId: "987",
        jobId: "11",
      }),
    ).resolves.toEqual({ githubRequestId: "JOB-RERUN-1" });
  });

  test("rejects a job from another workflow run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/access_tokens")) return tokenResponse();
        return response({ id: 11, run_id: 654, status: "completed" });
      }),
    );

    await expect(
      rerunGitHubActionsJob(credentials, {
        owner: "acme",
        repository: "widgets",
        workflowRunId: "987",
        jobId: "11",
      }),
    ).rejects.toMatchObject({ code: "ACTIONS_JOB_RUN_MISMATCH" });
  });
});
