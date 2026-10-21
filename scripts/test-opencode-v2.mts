import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { OpenCodeAdapter } from "../packages/control-agent/src/runs/opencode-adapter";
import { OpenCodeRuntime } from "../packages/control-agent/src/runs/opencode-runtime";
import {
  runFormAnswers,
  type RunQuestionField,
} from "../packages/agent-contract/src/run-forms";
import type {
  ProviderHandle,
  ProviderStartInput,
  ProviderUsage,
} from "../packages/control-agent/src/runs/provider";

// Real native CLI + real HTTP client, with a deterministic local model and isolated data.
const directory = await mkdtemp(join(tmpdir(), "aide-opencode-v2-"));
const previous = new Map<string, string | undefined>();
let adapter: OpenCodeAdapter | undefined;
let inspectionRuntime: OpenCodeRuntime | undefined;
let handle: ProviderHandle | undefined;
let calls = 0;
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  if (request.method !== "POST") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "smoke", object: "model" }] }));
    return;
  }
  calls++;
  const base = {
    id: `chatcmpl-smoke-${calls}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "smoke",
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "OpenCode 2 smoke passed." }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
try {
  for (const [name, value] of Object.entries({
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
    XDG_CACHE_HOME: join(directory, "cache"),
    CONTROL_AGENT_CONFIG: join(directory, "agent", "config.json"),
  })) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  adapter = new OpenCodeAdapter();
  const config = join(directory, "config", "opencode");
  const workspace = join(directory, "project");
  await mkdir(config, { recursive: true });
  await mkdir(workspace);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  await writeFile(
    join(config, "opencode.json"),
    JSON.stringify({
      model: "smoke/smoke",
      update: "disable",
      compaction: { auto: false },
      agents: { title: { model: "smoke/smoke" } },
      providers: {
        smoke: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: {
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "smoke-test",
          },
          models: {
            smoke: {
              name: "Smoke",
              modelID: "smoke",
              limit: { context: 200000, output: 10000 },
            },
          },
        },
      },
    }),
  );
  const usage: ProviderUsage[] = [];
  handle = await adapter.start(
    {
      run: {
        id: "smoke",
        kind: "SESSION",
        model: "smoke/smoke",
        effort: "auto",
        webSearchEnabled: false,
        worktree: { folder: workspace },
      } as ProviderStartInput["run"],
      prompt: "Reply with the smoke test result.",
      attachments: [],
    },
    {
      async onNativeId(_id, version) {
        assert.equal(version, "2.1.1");
      },
      async onQuestion() {
        throw new Error("Unexpected question in deterministic smoke test");
      },
      async onEvent() {},
      async onUsage(value) {
        usage.push(value);
      },
    },
  );
  const timeout = setTimeout(() => {
    void handle?.interrupt("CANCELLED");
  }, 60_000);
  try {
    const result = await handle.completion;
    assert.equal(result.status, "COMPLETED", result.error);
    assert.equal(result.finalOutput, "OpenCode 2 smoke passed.");
    assert(calls > 0);
    assert(
      usage.some(
        (entry) => entry.inputTokens === 5 && entry.outputTokens === 6,
      ),
    );
    assert(handle.nativeId);
    const continuedUsage: ProviderUsage[] = [];
    const continued = await adapter.start(
      {
        run: {
          id: "continue",
          kind: "SESSION",
          model: "smoke/smoke",
          effort: "auto",
          webSearchEnabled: false,
          worktree: { folder: workspace },
        } as ProviderStartInput["run"],
        prompt: "Continue with the smoke result.",
        attachments: [],
        resumeNativeId: handle.nativeId,
        fork: false,
      },
      {
        async onNativeId(id) {
          assert.equal(id, handle?.nativeId);
        },
        async onQuestion() {
          throw new Error("Unexpected continuation question");
        },
        async onEvent() {},
        async onUsage(value) {
          continuedUsage.push(value);
        },
      },
    );
    assert.equal((await continued.completion).status, "COMPLETED");
    assert.equal(
      continuedUsage.reduce(
        (total, entry) => total + (entry.inputTokens ?? 0),
        0,
      ),
      5,
    );
    inspectionRuntime = new OpenCodeRuntime();
    const { client } = await inspectionRuntime.client();
    const formSession = await client.session.create({
      location: { directory: workspace },
    });
    const fields = [
      { key: "enabled", type: "boolean", required: true },
      { key: "count", type: "integer", minimum: 0 },
      { key: "ratio", type: "number", maximum: 1 },
      {
        key: "choice",
        type: "string",
        options: [{ value: "native-id", label: "Friendly label" }],
      },
      {
        key: "detail",
        type: "string",
        when: [{ key: "choice", op: "eq", value: "native-id" }],
        required: true,
      },
      {
        key: "list",
        type: "multiselect",
        custom: true,
        options: [{ value: "id", label: "Item" }],
      },
      { key: "hidden", type: "string", hidden: true, default: "kept" },
      {
        key: "external",
        type: "external",
        url: "https://example.test/authorize",
      },
    ] satisfies [RunQuestionField, ...RunQuestionField[]];
    const form = await client.session.form.create({
      sessionID: formSession.id,
      title: "Native form smoke",
      fields,
    });
    assert(
      (await client.session.form.list({ sessionID: formSession.id })).some(
        (entry) => entry.id === form.id,
      ),
    );
    const answers = runFormAnswers(fields, {
      enabled: { value: false },
      count: { value: 0 },
      ratio: { value: 0.5 },
      choice: { value: "native-id" },
      detail: { value: "details" },
      list: { value: ["id", "custom"] },
      hidden: { value: "kept" },
      external: { value: true },
    });
    await assert.rejects(
      client.session.form.reply({
        sessionID: formSession.id,
        formID: form.id,
        answer: { ...answers, count: 1.5 },
      }),
    );
    await client.session.form.reply({
      sessionID: formSession.id,
      formID: form.id,
      answer: answers,
    });
    const detail = await client.session.form.get({
      sessionID: formSession.id,
      formID: form.id,
    });
    assert.equal(detail.state.status, "answered");
    if (detail.state.status === "answered")
      assert.deepEqual(detail.state.answer, { ...answers });
    const cancelled = await client.session.form.create({
      sessionID: formSession.id,
      title: "Cancel smoke",
      fields: [{ key: "answer", type: "string" }],
    });
    await client.session.form.cancel({
      sessionID: formSession.id,
      formID: cancelled.id,
    });
    assert.equal(
      (
        await client.session.form.get({
          sessionID: formSession.id,
          formID: cancelled.id,
        })
      ).state.status,
      "cancelled",
    );
    const catalog = await adapter.catalog([
      { id: "smoke-wt", folder: workspace, branch: null },
    ]);
    assert(
      catalog.worktrees?.["smoke-wt"]?.models.some(
        (entry) => entry.id === "smoke/smoke",
      ),
    );
    const imported = await adapter.discover([
      { id: "smoke-wt", folder: workspace, branch: null },
    ]);
    assert(
      imported.some(
        (entry) =>
          entry.nativeId === handle?.nativeId &&
          entry.finalOutput === result.finalOutput,
      ),
    );
    const target = join(directory, "second-project");
    await mkdir(target);
    const forked = await client.session.fork({ sessionID: handle.nativeId });
    await client.session.move({ sessionID: forked.id, directory: target });
    await client.session.wait({ sessionID: forked.id });
    assert.equal(
      (await client.session.get({ sessionID: forked.id })).location.directory,
      target,
    );
    await adapter.delete(forked.id, target);
    await adapter.delete(handle.nativeId, workspace);
    await assert.rejects(client.session.get({ sessionID: handle.nativeId }));
    await client.session.remove({ sessionID: formSession.id });
    console.log(
      "OpenCode 2.1.1 native smoke passed (service, execution/continuation, attempt usage, forms, rejection/reply/cancel, catalog/history, fork/move/delete).",
    );
  } finally {
    clearTimeout(timeout);
  }
} finally {
  await adapter?.close();
  await inspectionRuntime?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
}
