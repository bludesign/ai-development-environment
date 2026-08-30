import "server-only";

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

import type { SseHeader } from "./types";

const MAX_SCRIPT_LENGTH = 100_000;
const MAX_FETCH_BODY_BYTES = 10 * 1024 * 1024;

export type SseStoredValue = {
  key: string;
  value: unknown;
  version: number;
} | null;

export type SseScriptStorage = {
  get(key: string): Promise<SseStoredValue>;
  set(key: string, value: unknown): Promise<SseStoredValue>;
  delete(key: string): Promise<boolean>;
  compareAndSet(
    key: string,
    expectedVersion: number | null,
    value: unknown,
  ): Promise<SseStoredValue>;
  increment(key: string, delta: number): Promise<SseStoredValue>;
};

export type SseScriptRunOptions = {
  source: string;
  context: Record<string, unknown>;
  timeoutMs: number;
  memoryLimitMb: number;
  fetchTimeoutMs: number;
  storage: SseScriptStorage;
};

export type SseScriptRunResult = {
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
  name: string,
  operation: (input: unknown) => Promise<unknown>,
): void {
  const handle = vm.newFunction(name, (input) => {
    const deferred = vm.newPromise();
    void operation(hostJsonArgument(vm, input))
      .then((value) => deferred.resolve(jsonHandle(vm, { ok: true, value })))
      .catch((error) =>
        deferred.resolve(
          jsonHandle(vm, { ok: false, error: errorMessage(error) }),
        ),
      );
    void deferred.settled.then(vm.runtime.executePendingJobs);
    return deferred.handle;
  });
  handle.consume((value) => vm.setProp(vm.global, name, value));
}

function normalizeFetchHeaders(value: Headers): SseHeader[] {
  const headers: SseHeader[] = [];
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
  get: async (key) => callHost("__sseStorageGet", {key: String(key)}),
  set: async (key, value) => callHost("__sseStorageSet", {key: String(key), value}),
  delete: async (key) => callHost("__sseStorageDelete", {key: String(key)}),
  compareAndSet: async (key, expectedVersion, value) => callHost("__sseStorageCompareAndSet", {key: String(key), expectedVersion: expectedVersion == null ? null : Number(expectedVersion), value}),
  increment: async (key, delta = 1) => callHost("__sseStorageIncrement", {key: String(key), delta: Number(delta)}),
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
  const value = await callHost("__sseFetch", {url: String(url), init});
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
const rawContext = JSON.parse(__sseContextJson);
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

export async function runSseScript(
  options: SseScriptRunOptions,
): Promise<SseScriptRunResult> {
  const source = options.source.trim();
  if (source.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `SSE script must be ${MAX_SCRIPT_LENGTH.toLocaleString()} characters or fewer`,
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
  const consoleEntries: Array<{ level: string; message: string }> = [];
  vm.runtime.setMemoryLimit(options.memoryLimitMb * 1024 * 1024);
  vm.runtime.setMaxStackSize(1024 * 1024);
  vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  try {
    vm.newString(JSON.stringify(options.context)).consume((value) =>
      vm.setProp(vm.global, "__sseContextJson", value),
    );
    for (const level of ["log", "info", "warn", "error"] as const) {
      const handle = vm.newFunction(`__sseConsole${level}`, (...values) => {
        consoleEntries.push({
          level,
          message: values.map((value) => String(vm.dump(value))).join(" "),
        });
      });
      handle.consume((value) =>
        vm.setProp(vm.global, `__sseConsole${level}`, value),
      );
    }
    installAsyncHostFunction(vm, "__sseStorageGet", async (input) => {
      const { key } = input as { key: string };
      return options.storage.get(key);
    });
    installAsyncHostFunction(vm, "__sseStorageSet", async (input) => {
      const { key, value } = input as { key: string; value: unknown };
      return options.storage.set(key, value);
    });
    installAsyncHostFunction(vm, "__sseStorageDelete", async (input) => {
      const { key } = input as { key: string };
      return options.storage.delete(key);
    });
    installAsyncHostFunction(vm, "__sseStorageCompareAndSet", async (input) => {
      const { key, expectedVersion, value } = input as {
        key: string;
        expectedVersion: number | null;
        value: unknown;
      };
      return options.storage.compareAndSet(key, expectedVersion, value);
    });
    installAsyncHostFunction(vm, "__sseStorageIncrement", async (input) => {
      const { key, delta } = input as { key: string; delta: number };
      return options.storage.increment(key, delta);
    });
    installAsyncHostFunction(vm, "__sseFetch", async (input) => {
      const { url, init } = input as {
        url: string;
        init?: {
          method?: string;
          headers?: HeadersInit | SseHeader[];
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
        signal: AbortSignal.timeout(timeout),
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
    const evaluation = vm.evalCode(`${BOOTSTRAP}
console = Object.freeze({
  log: (...values) => __sseConsolelog(...values),
  info: (...values) => __sseConsoleinfo(...values),
  warn: (...values) => __sseConsolewarn(...values),
  error: (...values) => __sseConsoleerror(...values)
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
      const resolved = await resolvedPromise;
      const outputHandle = vm.unwrapResult(resolved);
      try {
        const output = JSON.parse(vm.getString(outputHandle)) as {
          resultDefined: boolean;
          result?: unknown;
          context: Record<string, unknown>;
        };
        return {
          result: output.result,
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
    throw new Error(
      message === "interrupted"
        ? `SSE script timed out after ${options.timeoutMs}ms`
        : `SSE script failed: ${message}`,
    );
  } finally {
    vm.dispose();
  }
}
