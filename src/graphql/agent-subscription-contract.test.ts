import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { buildSubgraphSchema } from "@apollo/subgraph";
import type { Client } from "graphql-ws";
import { expect, test, vi } from "vitest";

import { subscribeToAgentEvents } from "../../packages/control-agent/src/graphql-client";

// Apollo's external module must use the same GraphQL instance as the test.
const { concatAST, parse, subscribe, validate } = createRequire(
  import.meta.url,
)("graphql") as typeof import("graphql");

test("the agent notification subscription accepts the server schema and returns worktree resources", async () => {
  const schemasDirectory = new URL("../../schemas/", import.meta.url);
  const schema = buildSubgraphSchema([
    {
      typeDefs: concatAST(
        readdirSync(schemasDirectory)
          .filter((name) => name.endsWith(".graphql"))
          .map((name) =>
            parse(readFileSync(new URL(name, schemasDirectory), "utf8")),
          ),
      ),
    },
  ]);
  const client = {
    subscribe: vi.fn<Client["subscribe"]>(() => () => undefined),
  };
  const unsubscribe = subscribeToAgentEvents(
    client as unknown as Client,
    "agent-1",
    () => undefined,
  );
  const request = client.subscribe.mock.calls[0]![0] as {
    query: string;
    variables: { agentId: string };
  };
  unsubscribe();
  const document = parse(request.query);

  expect(validate(schema, document).map((error) => error.message)).toEqual([]);

  const worktree = {
    id: "worktree-1",
    folder: "/workspace/feature",
    branch: "feature",
    gitDirectory: "/workspace/repo/.git",
    codebaseId: "codebase-1",
  };
  const result = await subscribe({
    schema,
    document,
    variableValues: request.variables,
    rootValue: {
      agentEvents: async function* () {
        yield {
          agentEvents: {
            type: "RUN_COMMAND_AVAILABLE",
            runCommand: {
              id: "command-1",
              runId: "run-1",
              agentId: "agent-1",
              sequence: 1,
              type: "START",
              payload: {},
              status: "QUEUED",
              run: {
                id: "run-1",
                kind: "SESSION",
                displayNumber: 1,
                status: "QUEUED",
                phase: "QUEUED",
                origin: "MANAGED",
                provider: "CODEX",
                worktreeId: worktree.id,
                agentId: "agent-1",
                worktree,
                model: "test-model",
                webSearchEnabled: false,
                mcpToolNames: [],
                initialPrompt: "Run a task",
                inputs: [],
                attempts: [],
              },
            },
          },
        };
      },
    },
  });
  if (!(Symbol.asyncIterator in result)) {
    throw new Error(result.errors?.map((error) => error.message).join("; "));
  }
  const iterator = result[Symbol.asyncIterator]();
  try {
    const event = await iterator.next();
    if (event.done) throw new Error("The agent notification was not delivered");
    expect(event.value.errors).toBeUndefined();
    expect(event.value.data).toMatchObject({
      agentEvents: { runCommand: { run: { worktree } } },
    });
  } finally {
    await iterator.return?.();
  }
});
