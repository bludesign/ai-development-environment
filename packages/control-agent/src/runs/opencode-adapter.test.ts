import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ProviderCallbacks, ProviderStartInput } from "./provider.js";

const runtime = vi.hoisted(() => ({
  clients: [] as unknown[],
  instances: [] as Array<{
    isolated: boolean;
    close: ReturnType<typeof vi.fn>;
  }>,
  shared: vi.fn(),
}));
vi.mock("./opencode-runtime.js", () => ({
  OpenCodeRuntime: class {
    value = runtime.clients.shift();
    close = vi.fn();
    constructor(public isolated = false) {
      runtime.instances.push(this);
    }
    async client() {
      return { client: this.value, version: "2.1.1" };
    }
  },
  sharedOpenCodeClient: runtime.shared,
}));
import { OpenCodeAdapter } from "./opencode-adapter.js";

const session = {
  id: "ses_one",
  agent: "build",
  location: { directory: "/workspace" },
  time: { created: 1, updated: 2, idle: 3 },
  cost: 0.2,
  tokens: { input: 10 },
};
const user = {
  id: "msg_user",
  type: "user",
  text: "Fix imports",
  time: { created: 1 },
};
const assistant = {
  id: "msg_assistant",
  type: "assistant",
  model: { providerID: "openai", id: "test" },
  agent: "build",
  time: { created: 2, completed: 3 },
  content: [{ type: "text", text: "Done" }],
  tokens: { input: 10, output: 2 },
  cost: 0.2,
};
const idle = {
  id: "msg_idle",
  type: "idle",
  outcome: "succeeded",
  time: { created: 3 },
};
const form = {
  id: "frm_one",
  sessionID: session.id,
  title: "Details",
  fields: [
    { key: "enabled", type: "boolean", required: true },
    { key: "count", type: "integer", default: 0 },
  ],
};

function client() {
  return {
    migration: {
      v1: { status: vi.fn().mockResolvedValue({ status: "completed" }) },
    },
    model: {
      list: vi.fn().mockResolvedValue({
        data: [
          {
            id: "test",
            providerID: "openai",
            name: "Test",
            enabled: true,
            variants: [{ id: "high" }],
          },
        ],
      }),
    },
    provider: {
      list: vi
        .fn()
        .mockResolvedValue({ data: [{ id: "openai", name: "OpenAI" }] }),
    },
    mcp: { add: vi.fn().mockResolvedValue(undefined) },
    session: {
      inbox: { list: vi.fn().mockResolvedValue([]) },
      create: vi.fn().mockResolvedValue(session),
      get: vi.fn().mockResolvedValue(session),
      fork: vi.fn().mockResolvedValue({ ...session, id: "ses_fork" }),
      move: vi.fn(),
      switchAgent: vi.fn(),
      switchModel: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      active: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue({ data: [session], cursor: {} }),
      prompt: vi.fn().mockResolvedValue({ id: user.id, time: { created: 1 } }),
      wait: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue({ interrupted: true }),
      form: {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue({ state: { status: "pending" } }),
        reply: vi.fn(),
        cancel: vi.fn(),
      },
    },
    message: {
      list: vi
        .fn()
        .mockResolvedValue({ data: [user, assistant, idle], cursor: {} }),
    },
    permission: { list: vi.fn().mockResolvedValue([]), reply: vi.fn() },
    event: {
      subscribe: vi
        .fn()
        .mockImplementation(({ signal }: { signal: AbortSignal }) =>
          (async function* () {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
          })(),
        ),
    },
  };
}
function callbacks(): ProviderCallbacks {
  return {
    onNativeId: vi.fn(),
    onEvent: vi.fn(),
    onQuestion: vi.fn(),
    onQuestionResolved: vi.fn(),
    onUsage: vi.fn(),
  };
}
function input(
  overrides: Partial<ProviderStartInput> = {},
): ProviderStartInput {
  return {
    run: {
      id: "run-1",
      kind: "SESSION",
      model: "openai/test",
      effort: "high",
      webSearchEnabled: false,
      worktree: { folder: "/workspace" },
    } as ProviderStartInput["run"],
    prompt: "Fix imports",
    attachments: [],
    ...overrides,
  };
}
function prepare() {
  const api = client();
  runtime.clients.push(api);
  return { api, adapter: new OpenCodeAdapter() };
}
function executionClient(api: ReturnType<typeof client>) {
  api.message.list.mockResolvedValueOnce({ data: [], cursor: {} });
}
beforeEach(() => {
  vi.clearAllMocks();
  runtime.clients.length = 0;
  runtime.instances.length = 0;
  runtime.shared.mockResolvedValue(undefined);
});

describe("OpenCode 2 discovery", () => {
  test("follows native session/message cursors and preserves complete histories", async () => {
    const { api, adapter } = prepare();
    api.session.list
      .mockResolvedValueOnce({ data: [session], cursor: { next: "sessions" } })
      .mockResolvedValueOnce({ data: [], cursor: {} });
    api.message.list
      .mockResolvedValueOnce({ data: [user], cursor: { next: "messages" } })
      .mockResolvedValueOnce({ data: [assistant, idle], cursor: {} });
    const [run] = await adapter.discover([
      { id: "wt", folder: "/workspace", branch: "main" },
    ]);
    expect(run).toMatchObject({
      nativeId: session.id,
      prompt: "Fix imports",
      finalOutput: "Done",
      estimatedCost: 0.2,
      usage: [{ inputTokens: 10, outputTokens: 2 }],
    });
    expect(api.message.list).toHaveBeenLastCalledWith(
      { sessionID: session.id, limit: 200, cursor: "messages" },
      expect.anything(),
    );
    expect(api.session.list).toHaveBeenLastCalledWith(
      { directory: "/workspace", limit: 200, cursor: "sessions" },
      expect.anything(),
    );
  });
  test.each(["required", "running", "error"])(
    "defers incomplete migration: %s",
    async (status) => {
      const { api, adapter } = prepare();
      api.migration.v1.status.mockResolvedValue({
        status,
        error: "broken migration",
      });
      await expect(adapter.discover([])).rejects.toThrow(
        status === "error" ? "broken migration" : "migration is pending",
      );
      expect(api.session.list).not.toHaveBeenCalled();
    },
  );
  test("caches idle histories and refreshes activity discovered from the shared service", async () => {
    const { api, adapter } = prepare();
    const worktrees = [{ id: "wt", folder: "/workspace", branch: null }];
    await adapter.discover(worktrees);
    await adapter.discover(worktrees);
    expect(api.message.list).toHaveBeenCalledOnce();
    runtime.shared.mockResolvedValue({
      session: {
        active: vi
          .fn()
          .mockResolvedValue({ [session.id]: { type: "running" } }),
      },
    });
    expect((await adapter.discover(worktrees))[0]?.status).toBe("IN_PROGRESS");
    expect(api.message.list).toHaveBeenCalledTimes(2);
  });
  test("rejects repeated cursors and retries a failed hydration", async () => {
    const { api, adapter } = prepare();
    const worktrees = [{ id: "wt", folder: "/workspace", branch: null }];
    api.message.list.mockResolvedValue({
      data: [user],
      cursor: { next: "repeated" },
    });
    await expect(adapter.discover(worktrees)).rejects.toThrow(
      "Repeated OpenCode",
    );
    api.message.list.mockResolvedValue({ data: [user, assistant], cursor: {} });
    expect((await adapter.discover(worktrees))[0]?.finalOutput).toBe("Done");
  });
  test("returns enabled models with provider groups and worktree-scoped variants", async () => {
    const { api, adapter } = prepare();
    api.model.list.mockResolvedValueOnce({
      data: [
        {
          id: "scoped",
          providerID: "openai",
          name: "Scoped",
          enabled: true,
          variants: [],
        },
        { id: "disabled", providerID: "openai", enabled: false },
      ],
    });
    const result = await adapter.catalog([
      { id: "wt", folder: "/workspace", branch: null },
    ]);
    expect(result.models[0]).toMatchObject({
      id: "openai/test",
      efforts: ["auto", "high"],
      group: "OpenAI",
    });
    expect(result.worktrees?.wt?.models).toEqual([
      {
        id: "openai/scoped",
        label: "Scoped",
        efforts: ["auto"],
        group: "OpenAI",
      },
    ]);
  });
});

describe("OpenCode 2 execution", () => {
  test.each([
    ["Allow once", "once"],
    ["Always allow", "always"],
    ["Reject", "reject"],
  ])("replies to native permissions: %s", async (label, decision) => {
    const { api, adapter } = prepare();
    executionClient(api);
    const cb = callbacks();
    api.permission.list.mockResolvedValue([
      {
        id: "per_one",
        sessionID: session.id,
        action: "edit",
        resources: ["file.ts"],
      },
    ]);
    api.session.wait.mockImplementation(
      (_input, { signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const handle = await adapter.start(input(), cb);
    await vi.waitFor(() => expect(cb.onQuestion).toHaveBeenCalled());
    await handle.answer("per_one", { question: { answers: [label] } });
    expect(api.permission.reply).toHaveBeenCalledWith(
      { sessionID: session.id, requestID: "per_one", decision },
      expect.anything(),
    );
    await handle.interrupt("CANCELLED");
    await handle.completion;
  });
  test("cancels a native form and reports its resolution once", async () => {
    const { api, adapter } = prepare();
    executionClient(api);
    const cb = callbacks();
    api.session.form.list.mockResolvedValue([form]);
    api.session.wait.mockImplementation(
      (_input, { signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const handle = await adapter.start(input(), cb);
    await vi.waitFor(() => expect(cb.onQuestion).toHaveBeenCalled());
    await handle.cancelQuestion?.(form.id);
    await handle.cancelQuestion?.(form.id);
    expect(api.session.form.cancel).toHaveBeenCalledOnce();
    expect(cb.onQuestionResolved).toHaveBeenCalledWith(
      form.id,
      expect.objectContaining({ status: "CANCELLED" }),
    );
    await handle.interrupt("CANCELLED");
    await handle.completion;
  });
  test("waits beyond prompt acknowledgement and records only new attempt usage", async () => {
    const { api, adapter } = prepare();
    const cb = callbacks();
    const old = { ...assistant, id: "msg_old", cost: 10 };
    api.message.list
      .mockResolvedValueOnce({ data: [old], cursor: {} })
      .mockResolvedValue({ data: [old, user, assistant, idle], cursor: {} });
    let finish!: () => void;
    api.session.wait.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handle = await adapter.start(input(), cb);
    let completed = false;
    void handle.completion.then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(api.session.prompt).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    finish();
    expect(await handle.completion).toMatchObject({
      status: "COMPLETED",
      finalOutput: "Done",
    });
    expect(cb.onNativeId).toHaveBeenCalledWith(session.id, "2.1.1");
    expect(cb.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCost: 0.2, inputTokens: 10 }),
    );
    expect(api.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "build",
        model: { providerID: "openai", id: "test", variant: "high" },
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "websearch", resource: "*", effect: "deny" },
        ],
      }),
      expect.anything(),
    );
  });
  test("forks then moves and configures the child; direct continuation cannot move the source", async () => {
    const { api, adapter } = prepare();
    executionClient(api);
    api.session.fork.mockResolvedValue({
      ...session,
      id: "ses_fork",
      location: { directory: "/old" },
    });
    const handle = await adapter.start(
      input({ resumeNativeId: "ses_source" }),
      callbacks(),
    );
    await handle.completion;
    expect(api.session.move).toHaveBeenCalledWith(
      { sessionID: "ses_fork", directory: "/workspace" },
      expect.anything(),
    );
    api.session.get.mockResolvedValue({
      ...session,
      location: { directory: "/old" },
    });
    await expect(
      adapter.start(
        input({ resumeNativeId: session.id, fork: false }),
        callbacks(),
      ),
    ).rejects.toThrow("different worktree");
  });
  test("answers full typed forms, reports native rejection, and allows retry", async () => {
    const { api, adapter } = prepare();
    executionClient(api);
    const cb = callbacks();
    api.session.form.list.mockResolvedValue([form]);
    api.session.wait.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    // Abort-aware long execution while the form is pending.
    api.session.wait.mockImplementation(
      (_input, { signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    );
    const handle = await adapter.start(input(), cb);
    await vi.waitFor(() =>
      expect(cb.onQuestion).toHaveBeenCalledWith(
        form.id,
        expect.arrayContaining([
          expect.objectContaining({
            field: expect.objectContaining({ key: "enabled", type: "boolean" }),
          }),
        ]),
      ),
    );
    api.session.form.reply.mockRejectedValueOnce(
      new Error("Native validation rejected answer"),
    );
    await expect(
      handle.answer(form.id, {
        enabled: { value: false },
        count: { value: 0 },
      }),
    ).rejects.toThrow("rejected");
    expect(cb.onQuestionResolved).toHaveBeenCalledWith(
      form.id,
      expect.objectContaining({ status: "PENDING" }),
    );
    await handle.answer(form.id, {
      enabled: { value: false },
      count: { value: 0 },
    });
    expect(api.session.form.reply).toHaveBeenLastCalledWith(
      {
        sessionID: session.id,
        formID: form.id,
        answer: { enabled: false, count: 0 },
      },
      expect.anything(),
    );
    await handle.interrupt("PAUSED");
    expect((await handle.completion).status).toBe("PAUSED");
  });
  test("streams native forms without old SDK envelopes and reconciles external cancellation", async () => {
    const { api, adapter } = prepare();
    executionClient(api);
    const cb = callbacks();
    api.event.subscribe.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          yield { type: "form.created", data: { form } };
          yield {
            type: "form.cancelled",
            data: { id: form.id, sessionID: session.id },
          };
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        })(),
    );
    const handle = await adapter.start(input(), cb);
    await handle.completion;
    expect(cb.onQuestionResolved).toHaveBeenCalledWith(form.id, {
      status: "CANCELLED",
      answers: undefined,
    });
  });
  test.each(["failed", "interrupted"])(
    "maps native terminal %s",
    async (outcome) => {
      const { api, adapter } = prepare();
      executionClient(api);
      api.message.list.mockResolvedValue({
        data: [
          user,
          assistant,
          {
            ...idle,
            outcome,
            error: { type: "ProviderError", message: "Model failed" },
          },
        ],
        cursor: {},
      });
      const handle = await adapter.start(input(), callbacks());
      expect(await handle.completion).toMatchObject({
        status: outcome === "failed" ? "FAILED" : "CANCELLED",
        error: "Model failed",
      });
    },
  );
  test("uses separate runtime MCP connections for concurrent runs and cleans both", async () => {
    const { adapter } = prepare();
    const left = client();
    const right = client();
    executionClient(left);
    executionClient(right);
    runtime.clients.push(left, right);
    const descriptor = {
      name: "control",
      url: "https://control.test/mcp",
      headers: { authorization: "Bearer left" },
    };
    const [a, b] = await Promise.all([
      adapter.start(input({ mcpServer: descriptor }), callbacks()),
      adapter.start(
        input({
          mcpServer: {
            ...descriptor,
            headers: { authorization: "Bearer right" },
          },
        }),
        callbacks(),
      ),
    ]);
    await Promise.all([a.completion, b.completion]);
    expect(left.mcp.add).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          headers: descriptor.headers,
          oauth: false,
        }),
      }),
      expect.anything(),
    );
    expect(right.mcp.add).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          headers: { authorization: "Bearer right" },
        }),
      }),
      expect.anything(),
    );
    expect(
      runtime.instances
        .filter((instance) => instance.isolated)
        .every((instance) => instance.close.mock.calls.length === 1),
    ).toBe(true);
    await adapter.close();
  });
  test("sends file attachments and steering with the v2 delivery mode", async () => {
    const { api, adapter } = prepare();
    executionClient(api);
    const attachments = [
      {
        id: "file",
        filename: "a.txt",
        path: "/tmp/a.txt",
        contentType: "text/plain",
      },
    ];
    const handle = await adapter.start(input({ attachments }), callbacks());
    await handle.steer("Steer", attachments);
    await handle.completion;
    expect(api.session.prompt).toHaveBeenCalledWith(
      {
        sessionID: session.id,
        text: "Steer",
        files: [{ uri: "file:///tmp/a.txt", name: "a.txt" }],
        delivery: "steer",
      },
      expect.anything(),
    );
  });
});
