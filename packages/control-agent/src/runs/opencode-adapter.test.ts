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
