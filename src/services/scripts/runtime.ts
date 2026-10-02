import "server-only";

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

type ScriptHeader = { name: string; value: string };

export const MAX_SCRIPT_LENGTH = 100_000;
const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

export type ScriptStoredValue = {
  key: string;
  value: unknown;
  version: number;
} | null;

export type ScriptStorage = {
  get(key: string): Promise<ScriptStoredValue>;
  set(key: string, value: unknown): Promise<ScriptStoredValue>;
  delete(key: string): Promise<boolean>;
  compareAndSet(
    key: string,
    expectedVersion: number | null,
    value: unknown,
  ): Promise<ScriptStoredValue>;
  increment(key: string, delta: number): Promise<ScriptStoredValue>;
};

export type ScriptRunOptions = {
  source: string;
  context: Record<string, unknown>;
  timeoutMs: number;
  memoryLimitMb: number;
  fetchTimeoutMs: number;
  storage?: ScriptStorage;
  mode?: "sse" | "external";
  secrets?: string[];
};

export type ScriptRunResult = {
  result: unknown;
  resultDefined: boolean;
  context: Record<string, unknown>;
  console: Array<{ level: string; message: string }>;
  durationMs: number;
};

function errorMessage(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return String(value);
}

function hostJsonArgument(vm: QuickJSContext, handle?: QuickJSHandle) {
  if (!handle) return null;
  return JSON.parse(vm.getString(handle)) as unknown;
}

function jsonHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
  return vm.newString(JSON.stringify(value));
}

function installAsyncHostFunction(
  vm: QuickJSContext,
  pending: Set<ReturnType<QuickJSContext["newPromise"]>>,
  name: string,
  operation: (input: unknown) => Promise<unknown>,
): void {
  const handle = vm.newFunction(name, (input) => {
    const argument = hostJsonArgument(vm, input);
    const deferred = vm.newPromise();
    pending.add(deferred);
    void Promise.resolve()
      .then(() => operation(argument))
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: errorMessage(error) }),
      )
      .then((value) => {
        if (!deferred.alive || !vm.alive) return;
        jsonHandle(vm, value).consume((handle) => deferred.resolve(handle));
        pending.delete(deferred);
        deferred.dispose();
        vm.runtime.executePendingJobs().dispose();
      })
      .catch(() => {
        /* The deadline owns errors after disposal. */
      });
    return deferred.handle;
  });
  handle.consume((value) => vm.setProp(vm.global, name, value));
}

function normalizeFetchHeaders(value: Headers): ScriptHeader[] {
  const headers: ScriptHeader[] = [];
  value.forEach((headerValue, name) =>
    headers.push({ name, value: headerValue }),
  );
  return headers;
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_FETCH_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Script fetch response exceeded 10 MiB");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

const BOOTSTRAP = String.raw`
class HeaderBag {
  constructor(values = [], readOnly = false) { this.values = Array.isArray(values) ? values.map(({name, value}) => ({name: String(name), value: String(value)})) : []; this.readOnly = readOnly; }
  assertMutable() { if (this.readOnly) throw new TypeError("Original request headers are read-only"); }
  get(name) { const lower = String(name).toLowerCase(); return this.values.find((item) => item.name.toLowerCase() === lower)?.value ?? null; }
  getAll(name) { const lower = String(name).toLowerCase(); return this.values.filter((item) => item.name.toLowerCase() === lower).map((item) => item.value); }
  has(name) { return this.get(name) !== null; }
  set(name, value) { this.assertMutable(); const lower = String(name).toLowerCase(); this.values = this.values.filter((item) => item.name.toLowerCase() !== lower); this.values.push({name: String(name), value: String(value)}); }
  append(name, value) { this.assertMutable(); this.values.push({name: String(name), value: String(value)}); }
  delete(name) { this.assertMutable(); const lower = String(name).toLowerCase(); this.values = this.values.filter((item) => item.name.toLowerCase() !== lower); }
  replace(values) { this.assertMutable(); this.values = new HeaderBag(values).values; }
  toJSON() { return this.values; }
}
const callHost = async (name, input) => {
  const output = JSON.parse(await globalThis[name](JSON.stringify(input)));
  if (!output.ok) throw new Error(output.error || name + " failed");
  return output.value;
};
const storage = Object.freeze({
  get: async (key) => callHost("__scriptStorageGet", {key: String(key)}),
  set: async (key, value) => callHost("__scriptStorageSet", {key: String(key), value}),
  delete: async (key) => callHost("__scriptStorageDelete", {key: String(key)}),
  compareAndSet: async (key, expectedVersion, value) => callHost("__scriptStorageCompareAndSet", {key: String(key), expectedVersion: expectedVersion == null ? null : Number(expectedVersion), value}),
  increment: async (key, delta = 1) => callHost("__scriptStorageIncrement", {key: String(key), delta: Number(delta)}),
  update: async (key, updater) => {
    if (typeof updater !== "function") throw new TypeError("storage.update requires a function");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await storage.get(key);
      const value = await updater(current?.value, current);
      try { return await storage.compareAndSet(key, current?.version ?? null, value); }
      catch (error) { if (attempt === 7) throw error; }
    }
  }
});
const fetch = async (url, init = {}) => {
  const value = await callHost("__scriptFetch", {url: String(url), init});
  return Object.freeze({
    ok: value.status >= 200 && value.status < 300,
    status: value.status,
    statusText: value.statusText,
    url: value.url,
    redirected: value.redirected,
    headers: new HeaderBag(value.headers),
    text: async () => value.body,
    json: async () => JSON.parse(value.body)
  });
};
const rawContext = JSON.parse(__scriptContextJson);
if (rawContext.request?.headers) rawContext.request.headers = new HeaderBag(rawContext.request.headers, true);
for (const key of ["forward", "response"]) if (rawContext[key]?.headers) rawContext[key].headers = new HeaderBag(rawContext[key].headers);
const deepFreeze = (value) => {
  if (!value || typeof value !== "object" || value instanceof HeaderBag || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
};
const context = rawContext;
const request = context.request;
if (request) { for (const key of Object.keys(request)) if (key !== "headers") deepFreeze(request[key]); Object.freeze(request); }
const forward = context.forward;
const forwarding = forward;
const response = context.response;
const endpoint = context.endpoint;
deepFreeze(endpoint);
const event = context.event;
const buffers = context.buffers;
const phase = context.phase;
const originalRequest = request;
`;

export async function runScript(
  options: ScriptRunOptions,
): Promise<ScriptRunResult> {
  const source = options.source.trim();
  if (options.source.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `Script must be ${MAX_SCRIPT_LENGTH.toLocaleString()} characters or fewer`,
    );
  }
  if (!source) {
    return {
      result: undefined,
      resultDefined: false,
      context: structuredClone(options.context),
      console: [],
      durationMs: 0,
    };
  }
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const quickJs = await getQuickJS();
  const vm = quickJs.newContext();
  const pending = new Set<ReturnType<QuickJSContext["newPromise"]>>();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outputLength = 0;
  const redact = createScriptRedactor(options.secrets ?? []);
  const consoleEntries: Array<{ level: string; message: string }> = [];
  vm.runtime.setMemoryLimit(options.memoryLimitMb * 1024 * 1024);
  vm.runtime.setMaxStackSize(1024 * 1024);
  vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  try {
    vm.newString(JSON.stringify(options.context)).consume((value) =>
      vm.setProp(vm.global, "__scriptContextJson", value),
    );
    for (const level of ["log", "info", "warn", "error"] as const) {
      const handle = vm.newFunction(`__scriptConsole${level}`, (...values) => {
        if (consoleEntries.length >= 200 || outputLength >= 20_000) return;
        const message = redact(
          values
            .map((value) =>
              typeof vm.dump(value) === "string"
                ? String(vm.dump(value))
                : JSON.stringify(vm.dump(value)),
            )
            .join(" "),
        ).slice(0, 20_000 - outputLength);
        outputLength += message.length;
        consoleEntries.push({ level, message });
      });
      handle.consume((value) =>
        vm.setProp(vm.global, `__scriptConsole${level}`, value),
      );
    }
    if (options.storage) {
      installAsyncHostFunction(
        vm,
        pending,
        "__scriptStorageGet",
        async (input) => {
          const { key } = input as { key: string };
          return options.storage!.get(key);
        },
      );
      installAsyncHostFunction(
        vm,
        pending,
        "__scriptStorageSet",
        async (input) => {
          const { key, value } = input as { key: string; value: unknown };
          return options.storage!.set(key, value);
        },
      );
      installAsyncHostFunction(
        vm,
        pending,
        "__scriptStorageDelete",
        async (input) => {
          const { key } = input as { key: string };
          return options.storage!.delete(key);
        },
      );
      installAsyncHostFunction(
        vm,
        pending,
        "__scriptStorageCompareAndSet",
        async (input) => {
          const { key, expectedVersion, value } = input as {
            key: string;
            expectedVersion: number | null;
            value: unknown;
          };
          return options.storage!.compareAndSet(key, expectedVersion, value);
        },
      );
      installAsyncHostFunction(
        vm,
        pending,
        "__scriptStorageIncrement",
        async (input) => {
          const { key, delta } = input as { key: string; delta: number };
          return options.storage!.increment(key, delta);
        },
      );
    }
    installAsyncHostFunction(vm, pending, "__scriptFetch", async (input) => {
      const { url, init } = input as {
        url: string;
        init?: {
          method?: string;
          headers?: HeadersInit | ScriptHeader[];
          body?: string | null;
        };
      };
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Script fetch only supports HTTP and HTTPS URLs");
      }
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = Math.min(options.fetchTimeoutMs, remaining);
      const response = await globalThis.fetch(parsed, {
        method: init?.method,
        headers: init?.headers as HeadersInit | undefined,
        body: init?.body,
        redirect: "follow",
        signal: AbortSignal.any([AbortSignal.timeout(timeout), abort.signal]),
      });
      return {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        redirected: response.redirected,
        headers: normalizeFetchHeaders(response.headers),
        body: await readBoundedBody(response),
      };
    });
    const bootstrap =
      options.mode === "external"
        ? BOOTSTRAP.slice(0, BOOTSTRAP.indexOf("const storage =")) +
          BOOTSTRAP.slice(
            BOOTSTRAP.indexOf("const fetch ="),
            BOOTSTRAP.indexOf("const rawContext ="),
          ) +
          "const context = JSON.parse(__scriptContextJson);"
        : BOOTSTRAP;
    const evaluation = vm.evalCode(`${bootstrap}
console = Object.freeze({
  log: (...values) => __scriptConsolelog(...values),
  info: (...values) => __scriptConsoleinfo(...values),
  warn: (...values) => __scriptConsolewarn(...values),
  error: (...values) => __scriptConsoleerror(...values)
});
(async () => {
  let scriptResult;
  scriptResult = await (async () => { ${source}\n})();
  return JSON.stringify({
    resultDefined: scriptResult !== undefined,
    result: scriptResult,
    context: {
      ...context,
      request: context.request ? {...context.request, headers: context.request.headers?.toJSON?.() ?? context.request.headers} : context.request,
      forward: context.forward ? {...context.forward, headers: context.forward.headers?.toJSON?.() ?? context.forward.headers} : context.forward,
      response: context.response ? {...context.response, headers: context.response.headers?.toJSON?.() ?? context.response.headers} : context.response
    }
  });
})()`);
    const promiseHandle = vm.unwrapResult(evaluation);
    try {
      const resolvedPromise = vm.resolvePromise(promiseHandle);
      vm.runtime.executePendingJobs().unwrap();
      const resolved = await Promise.race([
        resolvedPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("interrupted")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
      const outputHandle = vm.unwrapResult(resolved);
      try {
        const output = JSON.parse(vm.getString(outputHandle)) as {
          resultDefined: boolean;
          result?: unknown;
          context: Record<string, unknown>;
        };
        return {
          result:
            options.mode === "external"
              ? sanitizeScriptResult(output.result, redact)
              : output.result,
          resultDefined: output.resultDefined,
          context: output.context,
          console: consoleEntries,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        outputHandle.dispose();
      }
    } finally {
      promiseHandle.dispose();
    }
  } catch (error) {
    const message = errorMessage(error);
    throw new ScriptExecutionError(
      redact(
        message === "interrupted"
          ? `${options.mode === "external" ? "Script" : "SSE script"} timed out after ${options.timeoutMs}ms`
          : `${options.mode === "external" ? "Script" : "SSE script"} failed: ${message}`,
      ).slice(0, 20_000),
      message === "interrupted" || /timeout|timed out|aborted/i.test(message),
      consoleEntries,
    );
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    for (const deferred of pending) if (deferred.alive) deferred.dispose();
    vm.dispose();
  }
}

export function createScriptRedactor(
  secrets: string[],
): (value: string) => string {
  const variants = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  return (value) =>
    variants.reduce(
      (text, secret) => text.split(secret).join("[REDACTED]"),
      value,
    );
}
function sanitizeScriptResult(
  value: unknown,
  redact: (text: string) => string,
): unknown {
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [redact(key), visit(entry)]),
      );
    if (item != null && redact(String(item)) !== String(item))
      return redact(String(item));
    return item;
  };
  const safe = visit(value ?? null);
  const serialized = JSON.stringify(safe);
  return serialized.length > 20_000
    ? { message: serialized.slice(0, 20_000), truncated: true }
    : safe;
}
export class ScriptExecutionError extends Error {
  constructor(
    message: string,
    readonly uncertain: boolean,
    readonly console: Array<{ level: string; message: string }>,
  ) {
    super(message);
  }
}
