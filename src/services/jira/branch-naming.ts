import "server-only";

import { createContext, Script } from "node:vm";

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
const SCRIPT_TIMEOUT_MS = 50;

function runBranchNamingScript(
  source: string,
  input: JiraBranchNamingInput,
  alreadyTaken?: string,
): string {
  const context = createContext(
    {
      input: Object.freeze({
        ...input,
        ...(alreadyTaken === undefined ? {} : { alreadyTaken }),
      }),
      output: undefined,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  try {
    new Script(`"use strict"; output = (${source})(input);`).runInContext(
      context,
      { timeout: SCRIPT_TIMEOUT_MS },
    );
  } catch (error) {
    throw new Error(
      `Jira branch naming function failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const output = context.output;
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

export function jiraBranchCandidates(
  sourceValue: string,
  input: JiraBranchNamingInput,
): string[] {
  const source = sourceValue.trim();
  if (!source || source.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `Jira branch naming function must contain 1–${MAX_SCRIPT_LENGTH.toLocaleString()} characters`,
    );
  }
  const candidates: string[] = [];
  let alreadyTaken: string | undefined;
  for (let index = 0; index < MAX_CANDIDATES; index += 1) {
    const candidate = runBranchNamingScript(source, input, alreadyTaken);
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

export function validateJiraBranchNamingScript(
  source: string,
  projectKey: string,
): string {
  const normalized = source.trim();
  jiraBranchCandidates(normalized, {
    ticketKey: `${projectKey}-123`,
    type: "Story",
    title: "Example ticket title",
  });
  jiraBranchCandidates(normalized, {
    ticketKey: `${projectKey}-124`,
    type: "Bug",
    title: "Example bug title",
  });
  return normalized;
}
