import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jiraBranchNameCandidates,
  jiraBranchGenerationPayload,
  type JiraAiBranchNaming,
} from "@ai-development-environment/agent-contract/worktrees";
import { CodexAdapter } from "./codex-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { OpenCodeRuntime } from "./opencode-runtime.js";
import type { ProviderAdapter, ProviderHandle } from "./provider.js";
import type { AgentJobHandler } from "../handlers/index.js";

export async function generateBranchName(
  naming: JiraAiBranchNaming,
  parentSignal: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) abort();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("Branch name generation timed out after 120 seconds"),
      ),
    120_000,
  );
  const directory = await mkdtemp(join(tmpdir(), "aide-branch-"));
  const signal = controller.signal;
  const adapter: ProviderAdapter | null =
    naming.provider === "CODEX"
      ? new CodexAdapter()
      : naming.provider === "CLAUDE"
        ? new ClaudeAdapter()
        : null;
  const runtime =
    naming.provider === "OPENCODE" ? new OpenCodeRuntime(true) : null;
  let handle: ProviderHandle | undefined;
  const interrupt = () => {
    void handle?.interrupt("CANCELLED").catch(() => undefined);
  };
  signal.addEventListener("abort", interrupt, { once: true });
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () =>
      reject(signal.reason ?? new Error("Branch generation cancelled"));
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
  });
  try {
    const output = await Promise.race([
      aborted,
      (async () => {
        signal.throwIfAborted();
        if (runtime) {
          const { client } = await runtime.client();
          const separator = naming.model.indexOf("/");
          if (naming.model !== "default" && separator < 1)
            throw new Error(
              "Invalid OpenCode model; select a provider/model from the catalog",
            );
          const result = await client.generate.text(
            {
              prompt: `Return only one valid Git branch name. Do not use tools or ask questions.\n\n${naming.prompt}`,
              ...(naming.model === "default"
                ? {}
                : {
                    model: {
                      providerID: naming.model.slice(0, separator),
                      id: naming.model.slice(separator + 1),
                      ...(naming.effort && naming.effort !== "auto"
                        ? { variant: naming.effort }
                        : {}),
                    },
                  }),
            },
            { signal },
          );
          return result.text;
        }
        handle = await adapter!.start(
          {
            textOnly: true,
            attachments: [],
            prompt: naming.prompt,
            run: {
              kind: "PLAN",
              model: naming.model,
              effort: naming.effort,
              webSearchEnabled: false,
              worktree: {
                id: "branch-generation",
                folder: directory,
                branch: null,
              },
            },
          },
          {
            onNativeId: async () => {},
            onEvent: async () => {},
            onUsage: async () => {},
            onQuestion: async () => {
              await handle?.interrupt("CANCELLED");
              controller.abort(
                new Error("Branch naming cannot ask interactive questions"),
              );
            },
          },
        );
        if (signal.aborted) {
          await handle.interrupt("CANCELLED");
          signal.throwIfAborted();
        }
        const result = await handle.completion;
        if (result.status !== "COMPLETED")
          throw new Error(
            result.error ?? `Branch generation ${result.status.toLowerCase()}`,
          );
        return result.finalOutput ?? "";
      })(),
    ]);
    return jiraBranchNameCandidates(output)[0]!;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
    signal.removeEventListener("abort", interrupt);
    if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
    if (signal.aborted)
      await handle?.interrupt("CANCELLED").catch(() => undefined);
    await adapter?.close?.();
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export const generateTicketBranch: AgentJobHandler = async (
  payload,
  _timeout,
  signal,
) => {
  const input = jiraBranchGenerationPayload(payload);
  const name = await generateBranchName(input.naming, signal);
  const branchName = jiraBranchNameCandidates(name).find(
    (branch) =>
      branch === input.currentBranch || !input.takenBranches.includes(branch),
  );
  if (!branchName)
    throw new Error("Every generated ticket branch name is already taken");
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    branchName,
  };
};
