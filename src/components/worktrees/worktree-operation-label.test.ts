import { describe, expect, test } from "vitest";
import { IOS_BUILD_JOB_KINDS } from "@ai-development-environment/agent-contract/builds";
import { CODEBASE_JOB_KINDS } from "@ai-development-environment/agent-contract/codebases";
import { WORKFLOW_JOB_KINDS } from "@ai-development-environment/agent-contract/workflows";
import { WORKTREE_JOB_KINDS } from "@ai-development-environment/agent-contract/worktrees";

import en from "../../../messages/en.json";
import de from "../../../messages/de.json";
import es from "../../../messages/es.json";
import fr from "../../../messages/fr.json";
import {
  worktreeOperationLabel,
  type OperationLabelTranslator,
} from "./worktree-operation-label";

function translator(labels: Record<string, string>): OperationLabelTranslator {
  return (key, values = {}) => {
    if (!Object.hasOwn(labels, key)) throw new Error(`Missing label: ${key}`);
    return Object.entries(values).reduce(
      (message, [name, value]) =>
        message.replaceAll(`{${name}}`, String(value)),
      labels[key],
    );
  };
}

const t = translator(en.worktrees.activeOperations);

describe("worktree operation labels", () => {
  test("uses the saved command name without exposing its script", () => {
    expect(
      worktreeOperationLabel(
        {
          kind: "command.run",
          commandName: "Run dev",
          payload: { script: "npm run dev", environment: { TOKEN: "secret" } },
        },
        t,
      ),
    ).toBe("Command: Run dev");
    expect(
      worktreeOperationLabel(
        { kind: "command.run", payload: { script: "npm run dev" } },
        t,
      ),
    ).toBe("Command");
  });

  test.each([
    ["OPEN_EDITOR", "Open editor"],
    ["FORCE_PUSH", "Force push"],
    ["SYNC", "Sync"],
    ["REBASE", "Rebase"],
    ["CANCEL_REBASE", "Cancel rebase"],
    ["PULL", "Pull"],
    ["PUSH", "Push"],
    ["RESET", "Reset"],
    ["CLEAR_LOCK", "Clear Git lock"],
    ["STASH_ALL", "Stash all"],
    ["STAGE_ALL", "Stage all"],
    ["UNSTAGE_ALL", "Unstage all"],
  ])("distinguishes worktree operation %s", (operation, expected) => {
    expect(
      worktreeOperationLabel(
        { kind: "worktree.operation", payload: { operation } },
        t,
      ),
    ).toBe(expected);
  });

  describe.each(["worktree.git.operation", "codebase.git.operation"])(
    "%s",
    (kind) => {
      test.each([
        ["SWITCH_BRANCH", "Switch branch"],
        ["DELETE_BRANCH", "Delete local branch"],
        ["DELETE_REMOTE_BRANCH", "Delete remote branch"],
        ["PULL_BRANCH", "Pull branch"],
        ["APPLY_STASH", "Apply stash"],
        ["DELETE_STASH", "Delete stash"],
      ])("distinguishes %s", (operation, expected) => {
        expect(
          worktreeOperationLabel({ kind, payload: { operation } }, t),
        ).toBe(expected);
      });
    },
  );

  test.each([
    ["BUILD", "Build"],
    ["TEST", "Test"],
    ["ANALYZE", "Analyze"],
    ["ARCHIVE", "Archive"],
    ["BUILD_FOR_TESTING", "Build for testing"],
    ["TEST_WITHOUT_BUILDING", "Test without building"],
  ])("includes scheme with build action %s", (action, expected) => {
    expect(
      worktreeOperationLabel(
        { kind: "ios.build.run", payload: { action, scheme: "AIDE" } },
        t,
      ),
    ).toBe(`${expected}: AIDE`);
    expect(
      worktreeOperationLabel({ kind: "ios.build.run", payload: { action } }, t),
    ).toBe(expected);
  });

  test.each([
    ["worktree.auto-sync", { phase: "SYNC" }, "Auto Sync"],
    ["worktree.auto-sync", { phase: "FINALIZE" }, "Finalize sync"],
    ["worktree.prepare", { action: "INSPECT" }, "Inspect preparations"],
    ["worktree.prepare", { action: "APPLY" }, "Apply preparations"],
    ["worktree.prepare", { action: "UNDO" }, "Undo preparations"],
    ["worktree.branch", { action: "CREATE" }, "Create worktree"],
    ["worktree.branch", { action: "CHANGE" }, "Change branch"],
    ["worktree.watch", { action: "START" }, "Start file watcher"],
    ["worktree.watch", { action: "STOP" }, "Stop file watcher"],
    [
      "workflow.git.checkpoint",
      { operation: "CAPTURE" },
      "Capture Git checkpoint",
    ],
    [
      "workflow.git.checkpoint",
      { operation: "COMPARE" },
      "Compare Git checkpoint",
    ],
    [
      "workflow.git.checkpoint",
      { operation: "RESTORE" },
      "Restore Git checkpoint",
    ],
  ])("distinguishes %s %j", (kind, payload, expected) => {
    expect(worktreeOperationLabel({ kind, payload }, t)).toBe(expected);
  });

  test.each([
    ...WORKTREE_JOB_KINDS,
    ...CODEBASE_JOB_KINDS,
    ...IOS_BUILD_JOB_KINDS,
    ...WORKFLOW_JOB_KINDS,
    "coverage.import",
    "command.run",
  ])("identifies supported job %s even without its payload", (kind) => {
    const label = worktreeOperationLabel({ kind }, t);
    expect(label).not.toBe(kind);
    expect(label).not.toMatch(/Operation in progress|undefined/);
  });

  test.each([undefined, null, [], "bad payload", 5, { operation: {} }])(
    "handles missing or malformed payload %j",
    (payload) => {
      expect(
        worktreeOperationLabel({ kind: "worktree.operation", payload }, t),
      ).toBe("Worktree operation");
    },
  );

  test.each([undefined, null, "", "   "])(
    "handles missing command name %j",
    (commandName) => {
      expect(
        worktreeOperationLabel({ kind: "command.run", commandName }, t),
      ).toBe("Command");
    },
  );

  test("omits the separator for an unavailable build scheme", () => {
    expect(
      worktreeOperationLabel(
        { kind: "ios.build.run", payload: { action: "TEST", scheme: "  " } },
        t,
      ),
    ).toBe("Test");
  });

  test.each([
    ["future.operation", {}, "future.operation"],
    ["future.operation", { action: "REPAIR" }, "future.operation (REPAIR)"],
    [
      "worktree.operation",
      { operation: "REPAIR" },
      "worktree.operation (REPAIR)",
    ],
    ["worktree.branch", { action: "REPAIR" }, "worktree.branch (REPAIR)"],
    ["worktree.auto-sync", { phase: "REPAIR" }, "worktree.auto-sync (REPAIR)"],
    ["constructor", {}, "constructor"],
    [
      "worktree.operation",
      { operation: "toString" },
      "worktree.operation (toString)",
    ],
  ])(
    "keeps unknown operations identifiable: %s %j",
    (kind, payload, expected) => {
      expect(worktreeOperationLabel({ kind, payload }, t)).toBe(expected);
    },
  );

  test.each([
    [de.worktrees.activeOperations, "Befehl: Run dev", "Analysieren: AIDE"],
    [es.worktrees.activeOperations, "Comando: Run dev", "Analizar: AIDE"],
    [fr.worktrees.activeOperations, "Commande : Run dev", "Analyser : AIDE"],
  ])(
    "localizes labels and preserves user-authored names",
    (labels, command, build) => {
      const translate = translator(labels);
      expect(
        worktreeOperationLabel(
          { kind: "command.run", commandName: "Run dev" },
          translate,
        ),
      ).toBe(command);
      expect(
        worktreeOperationLabel(
          {
            kind: "ios.build.run",
            payload: { action: "ANALYZE", scheme: "AIDE" },
          },
          translate,
        ),
      ).toBe(build);
    },
  );
});
