export const MAX_AGENT_REQUEST_ATTEMPTS = 5;

export class AgentRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, status: number, codes: string[] = []) {
    super(message);
    this.name = "AgentRequestError";
    this.retryable =
      (status < 400 || status >= 500 || [408, 425, 429].includes(status)) &&
      !codes.some((code) =>
        [
          "UNAUTHENTICATED",
          "FORBIDDEN",
          "BAD_USER_INPUT",
          "GRAPHQL_VALIDATION_FAILED",
          "NOT_FOUND",
        ].includes(code),
      ) &&
      !/^(?:Job|Run|Run attempt|Run command) not found(?: for this agent)?$/.test(
        message,
      );
  }
}

export function isRetryableAgentError(error: unknown): boolean {
  return !(error instanceof AgentRequestError) || error.retryable;
}

export function waitForAgentRetry(
  delay: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}
