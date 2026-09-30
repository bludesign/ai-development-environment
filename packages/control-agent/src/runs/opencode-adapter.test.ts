import { describe, expect, test, vi } from "vitest";

import type { ProviderCallbacks, ProviderStartInput } from "./provider.js";

const sdk = vi.hoisted(() => ({
  createOpencode: vi.fn(),
}));

const executableLookup = vi.hoisted(() => ({
  findExecutable: vi.fn(() => "/usr/local/bin/opencode"),
  prependPathDirectory: vi.fn(),
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencode: sdk.createOpencode,
}));

vi.mock("../executable-lookup.js", () => executableLookup);

import { OpenCodeAdapter } from "./opencode-adapter.js";

function discoveryClient() {
  const client = {
    v2: {
      session: {
        active: vi.fn(async () => ({ data: { data: {} } })),
        list: vi.fn(async () => ({ data: { data: [], cursor: {} } })),
        messages: vi.fn(),
      },
    },
    session: {
      list: vi.fn(async () => ({ data: [] })),
      status: vi.fn(async () => ({ data: {} })),
      messages: vi.fn(),
    },
  };
  sdk.createOpencode.mockResolvedValue({ client, server: { close: vi.fn() } });
  return client;
}

describe("OpenCode history discovery", () => {
  const worktrees = [
    { id: "worktree-1", folder: "/workspace", branch: "main" },
  ];
  const session = {
    id: "session-1",
    location: { directory: "/workspace" },
    time: { created: 1_000, updated: 2_000 },
    title: "Import test",
    cost: 0.2,
  };
  const user = {
    id: "user",
    type: "user",
    text: "Fix imports",
    time: { created: 1_000 },
  };
  const answer = {
    id: "assistant",
    type: "assistant",
    model: { providerID: "openai", id: "model-a" },
    time: { created: 2_000 },
    tokens: { input: 10 },
    cost: 0.2,
    content: [{ type: "text", text: "Done" }],
  };

  test("follows session and message cursors and hydrates legacy sessions too", async () => {
    const client = discoveryClient();
    client.v2.session.list.mockImplementation(
      async (params?: { cursor?: string }) =>
        ({
          data: {
            data: params?.cursor ? [] : [session],
            cursor: params?.cursor ? {} : { next: "sessions-next" },
          },
        }) as never,
    );
    client.v2.session.messages.mockImplementation(
      async (params: { cursor?: string }) => ({
        data: {
          data: params.cursor ? [answer] : [user],
          cursor: params.cursor ? {} : { next: "messages-next" },
        },
      }),
    );
    client.session.list.mockResolvedValue({
      data: [
        {
          id: "legacy",
          directory: "/workspace",
          time: { created: 1_000, updated: 2_000 },
          title: "Legacy",
        },
        { id: "elsewhere", directory: "/other" },
        { ...session, directory: "/workspace" },
      ],
    } as never);
    client.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            id: "legacy-assistant",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude",
            time: { created: 2_000 },
            tokens: { input: 30 },
            cost: 0.1,
          },
          parts: [{ id: "text", type: "text", text: "Legacy answer" }],
        },
      ],
    });
    const results = await new OpenCodeAdapter().discover(worktrees);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      finalOutput: "Done",
      prompt: "Fix imports",
      model: "openai/model-a",
      estimatedCost: 0.2,
      usage: [{ inputTokens: 10 }],
    });
    expect(results[1]).toMatchObject({
      nativeId: "legacy",
      finalOutput: "Legacy answer",
      model: "anthropic/claude",
      usage: [{ inputTokens: 30, estimatedCost: 0.1 }],
    });
    expect(client.v2.session.list).toHaveBeenLastCalledWith(
      { directory: "/workspace", limit: 200, cursor: "sessions-next" },
      { throwOnError: true },
    );
    expect(client.v2.session.messages).toHaveBeenLastCalledWith(
      { sessionID: "session-1", limit: 200, cursor: "messages-next" },
      { throwOnError: true },
    );
    expect(client.session.messages).toHaveBeenCalledOnce();
  });

  test("does not save a partial history and retries hydration failures", async () => {
    const client = discoveryClient();
    client.v2.session.list.mockResolvedValue({
      data: { data: [session], cursor: {} },
    } as never);
    client.v2.session.messages
      .mockResolvedValueOnce({
        data: { data: [user], cursor: { next: "next" } },
      })
      .mockRejectedValueOnce(new Error("History unavailable"))
      .mockResolvedValue({ data: { data: [user, answer], cursor: {} } });
    const adapter = new OpenCodeAdapter();
    await expect(adapter.discover(worktrees)).rejects.toThrow(
      "OpenCode history unavailable for 1 sessions: session-1: History unavailable",
    );
    expect(client.session.messages).not.toHaveBeenCalled();
    expect((await adapter.discover(worktrees))[0]?.finalOutput).toBe("Done");
  });

  test("caches idle snapshots but refreshes active sessions even with unchanged timestamps", async () => {
    const client = discoveryClient();
    client.v2.session.list.mockResolvedValue({
      data: { data: [session], cursor: {} },
    } as never);
    client.v2.session.messages.mockResolvedValue({
      data: { data: [answer], cursor: {} },
    });
    const adapter = new OpenCodeAdapter();
    await adapter.discover(worktrees);
    await adapter.discover(worktrees);
    expect(client.v2.session.messages).toHaveBeenCalledOnce();
    client.v2.session.active.mockResolvedValue({
      data: { data: { "session-1": { type: "running" } } },
    } as never);
    expect((await adapter.discover(worktrees))[0]?.status).toBe("IN_PROGRESS");
    expect(client.v2.session.messages).toHaveBeenCalledTimes(2);
    client.v2.session.active.mockResolvedValue({ data: { data: {} } });
    await adapter.discover(worktrees);
    expect(client.v2.session.messages).toHaveBeenCalledTimes(3);
  });

  test("imports legacy installations when the native v2 API is unavailable", async () => {
    const client = discoveryClient();
    client.v2.session.list.mockRejectedValue(new Error("Unsupported endpoint"));
    client.v2.session.active.mockRejectedValue(
      new Error("Unsupported endpoint"),
    );
    client.session.list.mockResolvedValue({
      data: [{ ...session, directory: "/workspace" }],
    } as never);
    client.session.messages.mockResolvedValue({ data: [] });
    client.session.status.mockResolvedValue({
      data: { "session-1": { type: "retry" } },
    } as never);
    expect((await new OpenCodeAdapter().discover(worktrees))[0]).toMatchObject({
      nativeId: "session-1",
      status: "IN_PROGRESS",
      events: [],
    });
  });

  test("hydrates legacy transcripts exposed by the v2 session list using supported page sizes", async () => {
    const client = discoveryClient();
    client.v2.session.list.mockResolvedValue({
      data: { data: [session], cursor: {} },
    } as never);
    client.v2.session.messages.mockImplementation(
      async (params: { limit: number }) => {
        if (params.limit > 200)
          throw {
            _tag: "InvalidRequestError",
            message: "Expected a value less than or equal to 200",
          };
        return { data: { data: [], cursor: { next: null, previous: null } } };
      },
    );
    client.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            id: "legacy-message",
            role: "assistant",
            providerID: "opencode-go",
            modelID: "deepseek-v4-flash",
            time: { created: 2_000 },
            tokens: { input: 20 },
            cost: 0.1,
          },
          parts: [{ id: "text", type: "text", text: "Restored answer" }],
        },
      ],
    });
    const [run] = await new OpenCodeAdapter().discover(worktrees);
    expect(run).toMatchObject({
      finalOutput: "Restored answer",
      model: "opencode-go/deepseek-v4-flash",
      usage: [{ inputTokens: 20 }],
      events: [expect.anything(), expect.anything()],
    });
    expect(client.session.messages).toHaveBeenCalledWith(
      { sessionID: "session-1", directory: "/workspace", limit: 200 },
      { throwOnError: true },
    );
    expect(client.session.list).toHaveBeenCalledWith(
      { directory: "/workspace", limit: 200 },
      { throwOnError: true },
    );
  });

  test("follows opaque legacy message cursors and keeps all model usage", async () => {
    const client = discoveryClient();
    client.session.list.mockResolvedValue({
      data: [{ ...session, directory: "/workspace" }],
    } as never);
    const message = (id: string, created: number) => ({
      info: {
        id,
        role: "assistant",
        providerID: "openai",
        modelID: "model-a",
        time: { created },
        tokens: { input: 10 },
        cost: 0.1,
      },
      parts: [{ type: "text", text: id }],
    });
    client.session.messages
      .mockResolvedValueOnce({
        data: [message("newest", 2_000)],
        response: {
          headers: new Headers({ "x-next-cursor": "opaque-older-cursor" }),
        },
      })
      .mockResolvedValueOnce({
        data: [message("oldest", 1_000)],
        response: { headers: new Headers() },
      });
    const [run] = await new OpenCodeAdapter().discover(worktrees);
    expect(run).toMatchObject({
      finalOutput: "newest",
      usage: [{ inputTokens: 20, estimatedCost: 0.2 }],
    });
    expect(run?.events?.map((event) => event.id)).toEqual([
      "message:oldest",
      "oldest:part:0",
      "message:newest",
      "newest:part:0",
    ]);
    expect(client.session.messages).toHaveBeenLastCalledWith(
      {
        sessionID: "session-1",
        directory: "/workspace",
        limit: 200,
        before: "opaque-older-cursor",
      },
      { throwOnError: true },
    );
  });

  test("falls back when the projected message API is unavailable", async () => {
    const client = discoveryClient();
    client.v2.session.list.mockResolvedValue({
      data: { data: [session], cursor: {} },
    } as never);
    client.v2.session.messages.mockRejectedValue({
      _tag: "SessionNotFoundError",
    });
    client.session.messages.mockResolvedValue({
      data: [
        {
          info: { id: "user", role: "user", time: { created: 1_000 } },
          parts: [{ type: "text", text: "Original prompt" }],
        },
      ],
    });
    expect(
      (await new OpenCodeAdapter().discover(worktrees))[0]?.events,
    ).toHaveLength(2);
  });

  test("retains successful sessions when another history is unavailable", async () => {
    const client = discoveryClient();
    client.v2.session.list.mockResolvedValue({
      data: { data: [session, { ...session, id: "unavailable" }], cursor: {} },
    } as never);
    client.v2.session.messages.mockImplementation(
      async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "unavailable") throw new Error("History unavailable");
        return { data: { data: [answer], cursor: {} } };
      },
    );
    client.session.messages.mockRejectedValue(new Error("History unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runs = await new OpenCodeAdapter().discover(worktrees);
      expect(runs[0]?.finalOutput).toBe("Done");
      expect(runs[1]?.events).toBeUndefined();
      expect(runs[1]?.usage).toBeUndefined();
      expect(runs[1]?.model).toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("unavailable: History unavailable"),
      );
    } finally {
      warning.mockRestore();
    }
  });
});

describe("OpenCodeAdapter questions", () => {
  test("uses a run-isolated MCP runtime and closes it when the run settles", async () => {
    const close = vi.fn();
    const client = {
      event: {
        subscribe: vi.fn(async () => ({
          stream: (async function* () {})(),
        })),
      },
      question: {
        list: vi.fn(async () => ({ data: [] })),
        reply: vi.fn(),
      },
      permission: {
        list: vi.fn(async () => ({ data: [] })),
        reply: vi.fn(),
      },
      session: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        prompt: vi.fn(async () => ({
          data: {
            info: { tokens: {} },
            parts: [{ type: "text", text: "Done" }],
          },
        })),
        status: vi.fn(async () => ({ data: {} })),
        messages: vi.fn(async () => ({ data: [] })),
      },
      v2: {
        session: {
          interrupt: vi.fn(),
          permission: {
            list: vi.fn(async () => ({ data: [] })),
            reply: vi.fn(),
          },
          question: { list: vi.fn(async () => ({ data: [] })), reply: vi.fn() },
        },
      },
    };
    sdk.createOpencode.mockResolvedValue({ client, server: { close } });
    const adapter = new OpenCodeAdapter();
    const handle = await adapter.start(
      {
        run: {
          kind: "SESSION",
          model: "default",
          effort: null,
          webSearchEnabled: false,
          worktree: { folder: "/workspace" },
        },
        prompt: "Implement",
        attachments: [],
        mcpServer: {
          name: "ai-development-environment",
          url: "https://control.test/api/mcp?run=run-1",
          headers: { authorization: "Bearer agent" },
        },
      } as unknown as ProviderStartInput,
      {
        onNativeId: vi.fn(async () => undefined),
        onEvent: vi.fn(async () => undefined),
        onQuestion: vi.fn(async () => undefined),
        onUsage: vi.fn(async () => undefined),
      },
    );

    expect(sdk.createOpencode).toHaveBeenCalledWith({
      port: 0,
      config: {
        mcp: {
          "ai-development-environment": {
            type: "remote",
            url: "https://control.test/api/mcp?run=run-1",
            headers: { authorization: "Bearer agent" },
            oauth: false,
          },
        },
      },
    });
    await expect(handle.completion).resolves.toMatchObject({
      status: "COMPLETED",
      finalOutput: "Done",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  test("recovers and answers a legacy question missed by the event stream", async () => {
    let resolvePrompt!: (value: unknown) => void;
    const prompt = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const pendingQuestion = {
      id: "request-1",
      sessionID: "session-1",
      questions: [
        {
          header: "API approach",
          question: "Which API approach should be used?",
          options: [
            { label: "REST API", description: "HTTP endpoints" },
            { label: "GraphQL API", description: "A GraphQL endpoint" },
            { label: "Server Actions", description: "Next.js actions" },
          ],
        },
      ],
    };
    const sessionPrompt = vi.fn(async () => prompt);
    const questionList = vi.fn(async () =>
      sessionPrompt.mock.calls.length
        ? { data: [pendingQuestion] }
        : { data: [] },
    );
    const questionReply = vi.fn(async () => ({ data: true }));
    const close = vi.fn();
    const client = {
      event: {
        subscribe: vi.fn(async () => ({
          stream: (async function* () {
            yield { type: "server.connected", properties: {} };
          })(),
        })),
      },
      question: {
        list: questionList,
        reply: questionReply,
      },
      permission: {
        list: vi.fn(async () => ({ data: [] })),
        reply: vi.fn(),
      },
      session: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        prompt: sessionPrompt,
        status: vi.fn(async () => ({ data: {} })),
        messages: vi.fn(async () => ({
          data: [
            {
              info: { tokens: {} },
              parts: [{ type: "text", text: "REST API selected." }],
            },
          ],
        })),
      },
      v2: {
        session: {
          interrupt: vi.fn(async () => ({ data: true })),
          permission: {
            list: vi.fn(async () => ({ data: [] })),
            reply: vi.fn(async () => ({ data: true })),
          },
          question: {
            list: vi.fn(async () => {
              throw new Error("v2 question surface unavailable");
            }),
            reply: vi.fn(async () => ({ data: true })),
          },
        },
      },
    };
    sdk.createOpencode.mockResolvedValue({
      client,
      server: { close },
    });
    const callbacks = {
      onNativeId: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
      onQuestion: vi.fn(async () => undefined),
      onUsage: vi.fn(async () => undefined),
    } satisfies ProviderCallbacks;
    const input = {
      run: {
        kind: "SESSION",
        model: "opencode/deepseek-v4-flash-free",
        effort: null,
        webSearchEnabled: false,
        worktree: { folder: "/workspace" },
      },
      prompt: "Ask me which API approach to use.",
      attachments: [],
    } as unknown as ProviderStartInput;
    const adapter = new OpenCodeAdapter();

    const handle = await adapter.start(input, callbacks);

    await vi.waitFor(
      () => {
        expect(callbacks.onQuestion).toHaveBeenCalledWith("request-1", [
          expect.objectContaining({
            id: "0",
            prompt: "Which API approach should be used?",
            options: expect.arrayContaining([
              expect.objectContaining({ label: "REST API" }),
            ]),
          }),
        ]);
      },
      { timeout: 2_500 },
    );
    resolvePrompt({
      data: {
        info: { tokens: {} },
        parts: [],
      },
    });
    const completionSettled = vi.fn();
    void handle.completion.then(completionSettled);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completionSettled).not.toHaveBeenCalled();

    await handle.answer("request-1", {
      question: { answers: ["REST API"] },
    });
    expect(questionReply).toHaveBeenCalledWith({
      requestID: "request-1",
      directory: "/workspace",
      answers: [["REST API"]],
    });

    await expect(handle.completion).resolves.toMatchObject({
      status: "COMPLETED",
      finalOutput: "REST API selected.",
    });
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });

  test("surfaces and answers a legacy permission request", async () => {
    let resolvePrompt!: (value: unknown) => void;
    const prompt = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const permissionReply = vi.fn(async () => {
      resolvePrompt({
        data: {
          info: { tokens: {} },
          parts: [{ type: "text", text: "Permission accepted." }],
        },
      });
      return { data: true };
    });
    const close = vi.fn();
    const client = {
      event: {
        subscribe: vi.fn(async () => ({
          stream: (async function* () {
            yield {
              type: "permission.asked",
              properties: {
                id: "permission-1",
                sessionID: "session-1",
                permission: "external_directory",
                patterns: ["/tmp/*"],
                metadata: {
                  filepath: "/tmp/aide119.diff",
                  parentDir: "/tmp",
                },
                always: ["/tmp/*"],
                tool: {
                  messageID: "message-1",
                  callID: "call-1",
                },
              },
            };
          })(),
        })),
      },
      question: {
        list: vi.fn(async () => ({ data: [] })),
        reply: vi.fn(),
      },
      permission: {
        list: vi.fn(async () => ({ data: [] })),
        reply: permissionReply,
      },
      session: {
        create: vi.fn(async () => ({ data: { id: "session-1" } })),
        prompt: vi.fn(async () => prompt),
        status: vi.fn(async () => ({ data: {} })),
        messages: vi.fn(async () => ({ data: [] })),
      },
      v2: {
        session: {
          interrupt: vi.fn(async () => ({ data: true })),
          permission: {
            list: vi.fn(async () => ({ data: [] })),
            reply: vi.fn(async () => ({ data: true })),
          },
          question: {
            list: vi.fn(async () => ({ data: [] })),
            reply: vi.fn(async () => ({ data: true })),
          },
        },
      },
    };
    sdk.createOpencode.mockResolvedValue({ client, server: { close } });
    const callbacks = {
      onNativeId: vi.fn(async () => undefined),
      onEvent: vi.fn(async () => undefined),
      onQuestion: vi.fn(async () => undefined),
      onUsage: vi.fn(async () => undefined),
    } satisfies ProviderCallbacks;
    const adapter = new OpenCodeAdapter();

    const handle = await adapter.start(
      {
        run: {
          kind: "PLAN",
          model: "opencode-go/deepseek-v4-flash",
          effort: "max",
          webSearchEnabled: false,
          worktree: { folder: "/workspace" },
        },
        prompt: "Read the generated diff.",
        attachments: [],
      } as unknown as ProviderStartInput,
      callbacks,
    );

    await vi.waitFor(() => {
      expect(callbacks.onQuestion).toHaveBeenCalledWith("permission-1", [
        {
          id: "permission",
          header: "Permission required",
          prompt: "OpenCode requests external directory permission for /tmp/*.",
          multiSelect: false,
          allowCustom: false,
          options: [
            {
              label: "Allow once",
              description: "Approve only this request.",
            },
            {
              label: "Always allow",
              description: "Approve this request and remember /tmp/*.",
            },
            {
              label: "Reject",
              description:
                "Deny this request and let OpenCode continue safely.",
            },
          ],
        },
      ]);
    });

    await handle.answer("permission-1", {
      permission: { answers: ["Allow once"] },
    });

    expect(permissionReply).toHaveBeenCalledWith({
      requestID: "permission-1",
      directory: "/workspace",
      reply: "once",
    });
    await expect(handle.completion).resolves.toMatchObject({
      status: "COMPLETED",
      finalOutput: "Permission accepted.",
    });
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("OpenCodeAdapter catalog", () => {
  test("lists every authenticated provider newest first, not just zen", async () => {
    const providers = vi.fn(async () => ({
      data: {
        providers: [
          {
            id: "opencode-go",
            name: "OpenCode Go",
            models: {
              "glm-5.1": { name: "GLM-5.1", release_date: "2026-04-07" },
              "kimi-k3": {
                name: "Kimi K3",
                release_date: "2026-07-16",
                variants: { max: { reasoningEffort: "max" } },
              },
            },
          },
          {
            id: "opencode",
            name: "OpenCode Zen",
            models: {
              "big-pickle": { name: "Big Pickle", release_date: "2025-10-17" },
            },
          },
        ],
      },
    }));
    sdk.createOpencode.mockResolvedValue({
      client: { config: { providers } },
      server: { close: vi.fn() },
    });

    await expect(new OpenCodeAdapter().catalog()).resolves.toEqual({
      models: [
        {
          id: "opencode-go/kimi-k3",
          label: "Kimi K3",
          efforts: ["auto", "max"],
          group: "OpenCode Go",
        },
        {
          id: "opencode-go/glm-5.1",
          label: "GLM-5.1",
          efforts: ["auto"],
          group: "OpenCode Go",
        },
        {
          id: "opencode/big-pickle",
          label: "Big Pickle",
          efforts: ["auto"],
          group: "OpenCode Zen",
        },
      ],
    });
  });
});

describe("OpenCodeAdapter shared runtime", () => {
  test("binds an ephemeral port so a server already on 4096 cannot break it", async () => {
    sdk.createOpencode.mockClear();
    sdk.createOpencode.mockResolvedValue({
      client: { config: { providers: vi.fn(async () => ({ data: {} })) } },
      server: { close: vi.fn() },
    });

    await new OpenCodeAdapter().catalog();

    expect(sdk.createOpencode).toHaveBeenCalledWith({ port: 0 });
  });
});
