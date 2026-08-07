#!/usr/bin/env tsx

import { homedir } from "node:os";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import RE2 from "re2";

const MAX_PATTERN_LENGTH = 1_024;

type Finding = {
  source: string;
  pattern: string;
  error: string;
};

const findings: Finding[] = [];
let checked = 0;
let dynamic = 0;

function databasePath(): string {
  const url = process.env.DATABASE_URL || "file:./prisma/dev.db";
  if (!/^file:/i.test(url)) {
    throw new Error("db:audit-re2 supports SQLite file: database URLs only");
  }
  const raw = url.replace(/^file:/i, "");
  const expanded =
    raw === "~" ? homedir() : raw.replace(/^~\//, `${homedir()}/`);
  return resolve(process.cwd(), expanded);
}

function check(source: string, pattern: unknown): void {
  if (typeof pattern !== "string" || !pattern) return;
  checked += 1;
  try {
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error(`exceeds ${MAX_PATTERN_LENGTH} characters`);
    }
    new RE2(pattern, "u");
  } catch (error) {
    findings.push({
      source,
      pattern,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function literalPattern(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.source === "LITERAL" && typeof record.value === "string"
    ? record.value
    : null;
}

function inspectConditions(value: unknown, source: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      inspectConditions(entry, `${source}[${index}]`),
    );
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.op === "MATCHES") {
    const pattern = literalPattern(record.right);
    if (pattern === null) dynamic += 1;
    else check(`${source}.right`, pattern);
  }
  for (const [key, child] of Object.entries(record)) {
    if (key !== "right") inspectConditions(child, `${source}.${key}`);
  }
}

function inspectDefinition(raw: string, source: string): void {
  try {
    const definition = JSON.parse(raw) as Record<string, unknown>;
    const triggers = Array.isArray(definition.triggers)
      ? definition.triggers
      : [];
    for (const trigger of triggers) {
      if (!trigger || typeof trigger !== "object" || Array.isArray(trigger))
        continue;
      const record = trigger as Record<string, unknown>;
      const config =
        record.config &&
        typeof record.config === "object" &&
        !Array.isArray(record.config)
          ? (record.config as Record<string, unknown>)
          : {};
      const id = typeof record.id === "string" ? record.id : "unknown";
      check(`${source}.trigger.${id}.commandPattern`, config.commandPattern);
      check(`${source}.trigger.${id}.outputPattern`, config.outputPattern);
      inspectConditions(config, `${source}.trigger.${id}.config`);
    }
    const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const record = node as Record<string, unknown>;
      const config =
        record.config &&
        typeof record.config === "object" &&
        !Array.isArray(record.config)
          ? (record.config as Record<string, unknown>)
          : {};
      const id = typeof record.id === "string" ? record.id : "unknown";
      check(`${source}.node.${id}.outputPattern`, config.outputPattern);
      inspectConditions(config, `${source}.node.${id}.config`);
    }
  } catch (error) {
    findings.push({
      source,
      pattern: "<invalid JSON>",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const path = databasePath();
const database = new Database(path, { fileMustExist: true, readonly: true });

try {
  for (const row of database
    .prepare(
      "SELECT id, defaultJiraBranchRegex AS pattern FROM CodebaseSettings",
    )
    .all() as Array<{ id: string; pattern: string }>) {
    check(`CodebaseSettings.${row.id}.defaultJiraBranchRegex`, row.pattern);
  }
  for (const row of database
    .prepare("SELECT id, jiraBranchRegex AS pattern FROM CodebaseRepository")
    .all() as Array<{ id: string; pattern: string | null }>) {
    check(`CodebaseRepository.${row.id}.jiraBranchRegex`, row.pattern);
  }
  for (const row of database
    .prepare("SELECT id, defaultJiraKeyRegex AS pattern FROM GitHubSettings")
    .all() as Array<{ id: string; pattern: string }>) {
    check(`GitHubSettings.${row.id}.defaultJiraKeyRegex`, row.pattern);
  }
  for (const row of database
    .prepare("SELECT id, jiraKeyRegex AS pattern FROM GitHubRepository")
    .all() as Array<{ id: string; pattern: string | null }>) {
    check(`GitHubRepository.${row.id}.jiraKeyRegex`, row.pattern);
  }
  for (const row of database
    .prepare("SELECT id, draftDefinitionJson AS definition FROM Workflow")
    .all() as Array<{ id: string; definition: string }>) {
    inspectDefinition(row.definition, `Workflow.${row.id}.draft`);
  }
  for (const row of database
    .prepare("SELECT id, definitionJson AS definition FROM WorkflowVersion")
    .all() as Array<{ id: string; definition: string }>) {
    inspectDefinition(row.definition, `WorkflowVersion.${row.id}`);
  }
  for (const row of database
    .prepare("SELECT id, configJson AS config FROM WorkflowTrigger")
    .all() as Array<{ id: string; config: string }>) {
    try {
      const config = JSON.parse(row.config) as Record<string, unknown>;
      check(`WorkflowTrigger.${row.id}.commandPattern`, config.commandPattern);
      check(`WorkflowTrigger.${row.id}.outputPattern`, config.outputPattern);
      inspectConditions(config, `WorkflowTrigger.${row.id}.config`);
    } catch (error) {
      findings.push({
        source: `WorkflowTrigger.${row.id}.configJson`,
        pattern: "<invalid JSON>",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  database.close();
}

if (findings.length) {
  console.error(
    `RE2 audit failed for ${findings.length} of ${checked} static patterns in ${path}:`,
  );
  for (const finding of findings) {
    console.error(`- ${finding.source}: ${JSON.stringify(finding.pattern)}`);
    console.error(`  ${finding.error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `RE2 audit passed for ${checked} static patterns in ${path}; ${dynamic} dynamic workflow patterns require runtime validation.`,
  );
}
