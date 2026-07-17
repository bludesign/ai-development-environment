import "server-only";

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSWASMModule,
} from "quickjs-emscripten";

import { validGitBranchName } from "@ai-development-environment/agent-contract/worktrees";

export const DEFAULT_JIRA_BRANCH_NAMING_SCRIPT = `function ({ ticketKey, type, title, alreadyTaken }) {
  const prefix = String(type).trim().toLowerCase() === "bug" ? "bugfix" : "feature";
  const slug = String(title).normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = \`${"${prefix}"}/${"${ticketKey}"}${'${slug ? `-${slug}` : ""}'}\`;
  if (!alreadyTaken) return base;
  const suffix = Number(String(alreadyTaken).slice(base.length + 1));
  return \`${"${base}"}-${"${Number.isInteger(suffix) && suffix >= 2 ? suffix + 1 : 2}"}\`;
}`;

export type JiraBranchNamingInput = {
  ticketKey: string;
  type: string;
  title: string;
};

const MAX_SCRIPT_LENGTH = 10_000;
const MAX_CANDIDATES = 100;
const SCRIPT_TIMEOUT_MS = 250;
const CANDIDATE_GENERATION_TIMEOUT_MS = 1_000;
const SCRIPT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const SCRIPT_STACK_LIMIT_BYTES = 512 * 1024;

function sandboxErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function runBranchNamingScript(
  quickJs: QuickJSWASMModule,
  source: string,
  input: JiraBranchNamingInput,
  generationDeadline: number,
  alreadyTaken?: string,
): string {
  const sandboxInput = JSON.stringify({
    ...input,
    ...(alreadyTaken === undefined ? {} : { alreadyTaken }),
  });
  const evaluationDeadline = Math.min(
    Date.now() + SCRIPT_TIMEOUT_MS,
    generationDeadline,
  );
  if (evaluationDeadline <= Date.now()) {
    throw new Error("Jira branch naming function failed: Script timed out");
  }
  let output: unknown;
  try {
    output = quickJs.evalCode(
      `"use strict"; const input = Object.freeze(${sandboxInput}); (${source})(input);`,
      {
        memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
        maxStackSizeBytes: SCRIPT_STACK_LIMIT_BYTES,
        shouldInterrupt: shouldInterruptAfterDeadline(evaluationDeadline),
      },
    );
  } catch (error) {
    const message = sandboxErrorMessage(error);
    throw new Error(
      `Jira branch naming function failed: ${
        message === "interrupted"
          ? `Script execution timed out after ${SCRIPT_TIMEOUT_MS}ms`
          : message
      }`,
    );
  }
  if (typeof output !== "string") {
    throw new Error("Jira branch naming function must return a string");
  }
  const branch = output.trim();
  if (!validGitBranchName(branch)) {
    throw new Error(
      `Jira branch naming function returned an invalid branch: ${branch || "(empty)"}`,
    );
  }
  return branch;
}

export async function jiraBranchCandidates(
  sourceValue: string,
  input: JiraBranchNamingInput,
): Promise<string[]> {
  const source = sourceValue.trim();
  if (!source || source.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `Jira branch naming function must contain 1–${MAX_SCRIPT_LENGTH.toLocaleString()} characters`,
    );
  }
  const candidates: string[] = [];
  const quickJs = await getQuickJS();
  const generationDeadline = Date.now() + CANDIDATE_GENERATION_TIMEOUT_MS;
  let alreadyTaken: string | undefined;
  for (let index = 0; index < MAX_CANDIDATES; index += 1) {
    const candidate = runBranchNamingScript(
      quickJs,
      source,
      input,
      generationDeadline,
      alreadyTaken,
    );
    if (candidates.includes(candidate)) {
      throw new Error(
        "Jira branch naming function must return a new name when alreadyTaken is provided",
      );
    }
    candidates.push(candidate);
    alreadyTaken = candidate;
  }
  return candidates;
}

export async function validateJiraBranchNamingScript(
  source: string,
  projectKey: string,
): Promise<string> {
  const normalized = source.trim();
  await jiraBranchCandidates(normalized, {
    ticketKey: `${projectKey}-123`,
    type: "Story",
    title: "Example ticket title",
  });
  await jiraBranchCandidates(normalized, {
    ticketKey: `${projectKey}-124`,
    type: "Bug",
    title: "Example bug title",
  });
  return normalized;
}
