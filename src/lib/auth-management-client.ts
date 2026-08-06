export async function authManagementRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/auth/management/${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const raw = await response.text();
  let body:
    | (T & {
        error?: { message?: string };
      })
    | undefined;

  if (raw) {
    try {
      body = JSON.parse(raw) as T & { error?: { message?: string } };
    } catch {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      throw new Error("The server returned an invalid JSON response.");
    }
  }

  if (!response.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }
  if (body === undefined)
    throw new Error("The server returned an empty response.");
  return body;
}
