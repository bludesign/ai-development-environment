import { z } from "zod";

import { requiredConfigSessionPaths } from "./config-descriptors";
import { configSchemaForKind } from "./config-schema";
import {
  isChoiceTriggerKind,
  isWorkflowChoiceKey,
  isResourceTriggerKind,
  WORKFLOW_RESOURCE_KINDS,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_TRIGGER_KINDS,
  workflowStaticSourceHandles,
  type WorkflowResourceKind,
  type WorkflowStepKind,
  type WorkflowTriggerKind,
} from "./kinds";
import { invalidWorkflowValueBindings } from "./session";
import {
  commandOutputPattern,
  validateCommandOutputPattern,
} from "./command-output-match";

export const WORKFLOW_FORMAT = "aide.workflow" as const;
export const WORKFLOW_SCHEMA_VERSION = 1 as const;

// The kind vocabularies live in `kinds.ts` so the config descriptors can key off
// them without importing this module (which reads those descriptors back for the
// catalog's config schemas). Re-exported here so importers keep their old paths.
export {
  isChoiceTriggerKind,
  isResourceTriggerKind,
  isWorkflowChoiceKey,
  WORKFLOW_CHOICE_KEY_PATTERN,
  WORKFLOW_RESOURCE_KINDS,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_TRIGGER_KINDS,
  workflowStaticSourceHandles,
  type WorkflowResourceKind,
  type WorkflowStepKind,
  type WorkflowTriggerKind,
} from "./kinds";

/**
 * One option a choice trigger offers. `key` is the stable identity: it names the
 * trigger's output handle and is what `triggerWorkflow` is called with, so
 * renaming a `label` leaves existing edges connected.
 */
export type WorkflowTriggerChoice = {
  key: string;
  label: string;
  description: string;
};

/**
 * The options a choice trigger's config declares. Entries missing a usable key
 * are dropped, so callers see only choices that can actually be routed; the
 * validator reports the malformed ones separately.
 */
export function workflowTriggerChoices(
  config: unknown,
): WorkflowTriggerChoice[] {
  const value = (config as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(value)) return [];
  const choices: WorkflowTriggerChoice[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (!isWorkflowChoiceKey(row.key) || seen.has(row.key)) continue;
    seen.add(row.key);
    choices.push({
      key: row.key,
      label:
        typeof row.label === "string" && row.label.trim() ? row.label : row.key,
      description: typeof row.description === "string" ? row.description : "",
    });
  }
  return choices;
}

/**
 * The session paths each resource kind guarantees for a run launched from it.
 * These mirror the `sessionData` the resource pages pass to `triggerWorkflow`,
 * and are what a RESOURCE_MANUAL trigger contributes to path availability.
 *
 * WORKTREE also seeds repository and ticket data resolved from its codebase
 * and branch. These links are optional, so the seed is an optimistic contract:
 * a step bound to a missing linked resource resolves to `undefined` at run
 * time.
 *
 * Worktree-derived kinds seed `pr.*` from the persisted worktree association,
 * so doing so does not require a GitHub request.
 */
const RESOURCE_KIND_SEED_PATHS: Record<WorkflowResourceKind, string[]> = {
  BUILD: [
    "build.*",
    "worktree.*",
    "codebase.*",
    "agent.*",
    "repo.*",
    "ticket.*",
  ],
  CODEBASE: ["codebase.*", "agent.*", "repo.*"],
  JIRA_TICKET: ["ticket.*", "comment.*"],
  AGENT_RUN: [
    "run.*",
    "worktree.*",
    "codebase.*",
    "agent.*",
    "repo.*",
    "ticket.*",
  ],
  GITHUB_PIPELINE: [
    "pipeline.*",
    "repo.*",
    "pr.*",
    "worktree.*",
    "codebase.*",
    "agent.*",
    "ticket.*",
  ],
  GITHUB_JOB: [
    "job.*",
    "pipeline.*",
    "repo.*",
    "pr.*",
    "worktree.*",
    "codebase.*",
    "agent.*",
    "ticket.*",
  ],
  PULL_REQUEST: ["pr.number", "repo.displayOrigin"],
  WORKTREE: [
    "worktree.*",
    "codebase.*",
    "agent.*",
    "repo.*",
    "ticket.*",
    "pr.*",
  ],
  COMMAND_RUN: ["command.*", "agent.*", "worktree.*", "codebase.*", "repo.*"],
  SKILL: ["skill.*", "repo.*", "codebase.*"],
  SKILL_SYNC: ["skillSync.*", "skill.*", "repo.*", "codebase.*", "worktree.*"],
  IOS_DEVICE: ["device.*"],
  SIGNING_PROFILE: ["signingProfile.*", "device.*", "agent.*"],
  PUSH_NOTIFICATION_BATCH: ["pushBatch.*"],
  BUILD_DATA_COLLECTION: ["buildData.*", "agent.*", "worktree.*", "codebase.*"],
};

/** The resource kind a resource trigger config targets, if valid. */
export function workflowResourceKind(
  config: unknown,
): WorkflowResourceKind | null {
  const value = (config as { resourceKind?: unknown } | null)?.resourceKind;
  return typeof value === "string" &&
    (WORKFLOW_RESOURCE_KINDS as readonly string[]).includes(value)
    ? (value as WorkflowResourceKind)
    : null;
}

/**
 * Seed paths a trigger contributes on top of `workflow.*`. The resource
 * triggers derive them from their configured resource kind; every other kind
 * uses the static catalog seeds.
 */
export function resourceManualSeedPaths(
  kind: string,
  config: unknown,
): string[] {
  if (!isResourceTriggerKind(kind)) return [];
  const resourceKind = workflowResourceKind(config);
  return resourceKind ? RESOURCE_KIND_SEED_PATHS[resourceKind] : [];
}
export type WorkflowCatalogEntry = {
  kind: WorkflowStepKind;
  category: string;
  label: string;
  /** One or two sentences: what the step does. Shown in the editor palette. */
  description: string;
  /**
   * The long form: preconditions, credentials, side effects, failure modes, and
   * what lands in session data. Served through the catalog to the MCP tools so
   * an agent can pick between neighbouring steps without reading the adapter.
   */
  details: string;
  execution: "SERVER" | "AGENT" | "CONTROL" | "WAIT";
  configSchema: Record<string, unknown>;
  capabilityFlags: string[];
  requiredPaths: string[];
  providedPaths: string[];
  /** Outgoing handle ids an edge may leave this step from. */
  sourceHandles: string[];
  mutatesExternal: boolean;
  mutatesWorktree: boolean;
};

type StepFacts = {
  description: string;
  details: string;
  mutatesExternal?: boolean;
  mutatesWorktree?: boolean;
};

const step = (
  kind: WorkflowStepKind,
  category: string,
  label: string,
  execution: WorkflowCatalogEntry["execution"],
  requiredPaths: string[],
  providedPaths: string[],
  facts: StepFacts,
): WorkflowCatalogEntry => ({
  kind,
  category,
  label,
  description: facts.description,
  details: facts.details,
  execution,
  configSchema: configSchemaForKind(kind, "step"),
  capabilityFlags: [
    execution,
    ...(facts.mutatesExternal ? ["MUTATES_EXTERNAL"] : []),
    ...(facts.mutatesWorktree ? ["MUTATES_WORKTREE"] : []),
  ],
  requiredPaths,
  providedPaths,
  sourceHandles: workflowStaticSourceHandles(kind),
  mutatesExternal: facts.mutatesExternal ?? false,
  mutatesWorktree: facts.mutatesWorktree ?? false,
});

/** Shared closing note for the steps that resolve their subject from session data. */
const FALLS_BACK_TO_SESSION =
  "Leave the identifier unset to take it from session data.";

/** Related resources refreshed after a successful worktree-backed agent job. */
const WORKTREE_CONTEXT_PATHS = [
  "worktree.*",
  "codebase.*",
  "agent.*",
  "repo.*",
  "ticket.*",
  "pr.*",
];

/** Related resources refreshed after a successful codebase-backed agent job. */
const CODEBASE_CONTEXT_PATHS = ["codebase.*", "agent.*", "repo.*"];

const expansionStep = (
  kind: WorkflowStepKind,
  category: string,
  label: string,
  requiredPaths: string[] = [],
  providedPaths: string[] = ["steps.<stepId>.*"],
  facts: Pick<StepFacts, "mutatesExternal" | "mutatesWorktree"> = {},
) =>
  step(kind, category, label, "SERVER", requiredPaths, providedPaths, {
    description: `${label} using the control plane's typed service API.`,
    details: `${label} is a first-class action with validated configuration, audit-friendly output, resource links where available, and normal workflow failure routing.`,
    ...facts,
  });

const EXPANSION_STEP_CATALOG: WorkflowCatalogEntry[] = [
  expansionStep(
    "COMMAND_RERUN",
    "Commands",
    "Rerun command",
    ["command.id"],
    ["command.*"],
  ),
  expansionStep(
    "COMMAND_TERMINATE",
    "Commands",
    "Terminate command",
    ["command.id"],
    ["command.*"],
  ),
  expansionStep(
    "COMMAND_READ_OUTPUT",
    "Commands",
    "Read command output",
    ["command.id"],
    ["command.*"],
  ),
  expansionStep(
    "WORKTREE_INSPECT_DIFF",
    "Worktrees",
    "Inspect worktree diff",
    ["worktree.id"],
    ["worktree.diff.*"],
  ),
  expansionStep(
    "WORKTREE_UPDATE_METADATA",
    "Worktrees",
    "Update worktree metadata",
    ["worktree.id"],
    WORKTREE_CONTEXT_PATHS,
  ),
  expansionStep(
    "WORKTREE_MOVE_CONTROL",
    "Worktrees",
    "Control worktree move",
    [],
    WORKTREE_CONTEXT_PATHS,
    { mutatesWorktree: true },
  ),
  expansionStep(
    "BUILD_REBUILD",
    "Builds",
    "Rebuild build",
    ["build.id"],
    ["build.*"],
  ),
  expansionStep(
    "BUILD_GENERATE_REPORT",
    "Builds",
    "Generate build report",
    ["build.id"],
    ["build.*"],
  ),
  expansionStep("BUILD_DELETE", "Builds", "Delete builds", [], ["build.*"]),
  expansionStep(
    "SKILL_PREPARE_SYNC",
    "Skills",
    "Prepare skill sync",
    [],
    ["skillSync.*"],
  ),
  expansionStep(
    "SKILL_RESOLVE_SYNC",
    "Skills",
    "Resolve skill sync conflict",
    ["skillSync.id"],
    ["skillSync.*"],
  ),
  expansionStep(
    "SKILL_SKIP_SYNC",
    "Skills",
    "Skip skill sync",
    ["skillSync.id"],
    ["skillSync.*"],
  ),
  expansionStep(
    "BUILD_DATA_REFRESH",
    "Build Data",
    "Refresh build data",
    [],
    ["buildData.*"],
  ),
  expansionStep(
    "BUILD_DATA_DELETE",
    "Build Data",
    "Delete build data",
    ["buildData.id"],
    ["buildData.*"],
  ),
  expansionStep(
    "BUILD_DATA_SET_LOCK",
    "Build Data",
    "Set build-data lock",
    ["buildData.id"],
    ["buildData.*"],
  ),
  expansionStep(
    "SIGNING_REFRESH",
    "Signing",
    "Refresh signing assets",
    [],
    ["signing.*"],
  ),
  expansionStep(
    "SIGNING_SYNC_PROFILE",
    "Signing",
    "Sync signing profile",
    ["signingProfile.id"],
    ["signing.*"],
  ),
  expansionStep(
    "SIGNING_DELETE_EXPIRED",
    "Signing",
    "Delete expired profiles",
    [],
    ["signing.*"],
  ),
  expansionStep(
    "IOS_DEVICE_REGISTER",
    "Devices",
    "Register iOS device",
    ["device.id"],
    ["device.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "IOS_DEVICE_REJECT",
    "Devices",
    "Reject iOS device",
    ["device.id"],
    ["device.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "AGENT_RECONCILE",
    "Agents",
    "Reconcile agents",
    [],
    ["agent.*"],
  ),
  expansionStep(
    "AGENT_UPDATE_CADENCE",
    "Agents",
    "Update agent cadence",
    ["agent.id"],
    ["agent.*"],
  ),
  expansionStep(
    "CCUSAGE_COLLECT",
    "Operations",
    "Collect usage",
    [],
    ["usage.*"],
  ),
  expansionStep(
    "MODEL_COST_REFRESH",
    "Operations",
    "Refresh model costs",
    [],
    ["modelCosts.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "GITHUB_UPDATE_PR",
    "GitHub",
    "Update pull request",
    ["pr.number", "repo.*"],
    ["pr.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "GITHUB_SUBMIT_REVIEW",
    "GitHub",
    "Submit pull request review",
    ["pr.number", "repo.*"],
    ["pr.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "GITHUB_REQUEST_REVIEWERS",
    "GitHub",
    "Request pull request reviewers",
    ["pr.number", "repo.*"],
    ["pr.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "GITHUB_DISPATCH_WORKFLOW",
    "GitHub",
    "Dispatch GitHub workflow",
    ["repo.*"],
    ["pipeline.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "JIRA_CREATE_TICKET",
    "Jira",
    "Create Jira ticket",
    [],
    ["ticket.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "JIRA_ADD_WORKLOG",
    "Jira",
    "Add Jira worklog",
    ["ticket.key"],
    ["ticket.*"],
    { mutatesExternal: true },
  ),
  expansionStep(
    "JIRA_LINK_TICKETS",
    "Jira",
    "Link Jira tickets",
    ["ticket.key"],
    ["ticket.*"],
    { mutatesExternal: true },
  ),
];

export const WORKFLOW_STEP_CATALOG: readonly WorkflowCatalogEntry[] = [
  step(
    "JIRA_LOAD_TICKET",
    "Jira",
    "Load Jira ticket",
    "SERVER",
    [],
    ["ticket.*"],
    {
      description:
        "Reads a Jira issue and puts its fields — key, title, type, status, assignee, labels — into session data as `ticket.*`.",
      details: `Needs a configured Jira credential. ${FALLS_BACK_TO_SESSION} Results are served from cache unless "Bypass cache" is set, so a step that reads a ticket right after changing it should force a refresh. Fails when the issue does not exist or the credential cannot see it. Read-only: it changes nothing in Jira.`,
    },
  ),
  step(
    "JIRA_TRANSITION",
    "Jira",
    "Transition Jira ticket",
    "SERVER",
    ["ticket.key"],
    ["ticket.*"],
    {
      description:
        "Moves a ticket to another status by applying one of its workflow transitions.",
      details:
        "Takes a transition id, not a status name — the ids are board-specific, so read them from the ticket's available transitions rather than hard-coding a guess. Fails when the transition is not currently available on that issue, which is what happens if an earlier step already moved it. Refreshes `ticket.*` from the response.",
      mutatesExternal: true,
    },
  ),
  step(
    "JIRA_COMMENT",
    "Jira",
    "Add Jira comment",
    "SERVER",
    ["ticket.key"],
    ["ticket.*"],
    {
      description:
        "Posts a comment on a Jira issue, written in Markdown or Jira wiki markup.",
      details:
        "The comment body is converted from Markdown by default; choose Jira wiki format to pass markup through untouched. Comments are never deduplicated, so a step that runs twice comments twice — guard it with a condition if the workflow can retry. Refreshes `ticket.*` from the response.",
      mutatesExternal: true,
    },
  ),
  step(
    "JIRA_ASSIGN",
    "Jira",
    "Assign Jira ticket",
    "SERVER",
    ["ticket.key"],
    ["ticket.*"],
    {
      description:
        "Sets the assignee of a Jira issue, or clears it when no account is given.",
      details:
        "Takes a Jira account id rather than a display name or email. Leaving the assignee empty unassigns the ticket. Fails when the account cannot be assigned on that project. Refreshes `ticket.*` from the response.",
      mutatesExternal: true,
    },
  ),
  step(
    "JIRA_UPDATE_FIELDS",
    "Jira",
    "Update Jira fields",
    "SERVER",
    ["ticket.key"],
    ["ticket.*"],
    {
      description:
        "Patches arbitrary fields on a Jira issue — labels, summary, custom fields — from a JSON object.",
      details:
        "The escape hatch for anything the dedicated Jira steps do not cover. Keys are passed to the Jira update API as given, so an unknown or screen-hidden field fails the step. Prefer the specific steps for status and assignee. Refreshes `ticket.*` from the response.",
      mutatesExternal: true,
    },
  ),
  step(
    "JIRA_RESOLVE_BRANCH",
    "Jira",
    "Resolve ticket branch",
    "SERVER",
    ["ticket.key", "ticket.title", "ticket.type"],
    ["worktree.branch", "ticket.key", "ticket.title", "ticket.type"],
    {
      description:
        "Works out the branch name a ticket would get under the codebase's naming convention, without creating anything.",
      details:
        "A preview step: it writes `worktree.branch` plus the ticket key, title, and type into session data and touches neither Git nor Jira. Use it before Create worktree when you want the branch name available to earlier steps — for a worktree keyed off a ticket, Create worktree in TICKET mode derives the same name on its own.",
    },
  ),
  step(
    "GITHUB_LOAD_PR",
    "GitHub",
    "Load pull request",
    "SERVER",
    [],
    ["pr.*"],
    {
      description:
        "Reads a pull request and puts its state, branches, labels, checks, and review threads into session data as `pr.*`.",
      details: `Needs a configured GitHub credential. Owner and repository default to the repository already in session data, and the number to \`pr.number\`. Fails when the pull request does not exist or the credential cannot see it. Read-only.`,
    },
  ),
  step(
    "GITHUB_MERGE_PR",
    "GitHub",
    "Merge pull request",
    "SERVER",
    ["pr.number"],
    ["pr.state"],
    {
      description:
        "Merges an open pull request using squash, merge, or rebase, optionally overriding the commit message.",
      details:
        "Checks mergeability first and fails with GitHub's own blocking reason — conflicts, failing required checks, missing approvals, an already-closed pull request — rather than forcing the merge. Commit headline and body default to what GitHub would use. Squash is the default method. Irreversible, and repository policy may delete the head branch as a side effect, which strands any worktree still on it. Writes `pr.state`.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_COLLECT_REVIEW_THREADS",
    "GitHub",
    "Collect review comments",
    "SERVER",
    ["pr.number"],
    ["pr.unresolvedThreads"],
    {
      description:
        "Gathers the unresolved review threads on a pull request into `pr.unresolvedThreads`.",
      details:
        "Resolved threads are filtered out. The result is a list, so it pairs with For each to work through the comments one at a time — the reply and resolve steps take a single thread id from the iteration. Read-only.",
    },
  ),
  step(
    "GITHUB_REPLY_REVIEW_THREAD",
    "GitHub",
    "Reply to review thread",
    "SERVER",
    ["pr.unresolvedThreads"],
    [],
    {
      description: "Posts a reply into an existing pull request review thread.",
      details:
        "Takes the thread id from Collect review comments, usually inside a For each. Replies are not deduplicated, so a retried step comments twice. Replying does not resolve the thread — follow with Resolve review thread when that is the intent.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_SET_REVIEW_THREAD_RESOLVED",
    "GitHub",
    "Resolve review thread",
    "SERVER",
    ["pr.unresolvedThreads"],
    [],
    {
      description:
        "Marks a pull request review thread resolved, or reopens it.",
      details:
        "Takes the thread id from Collect review comments. Resolving is the default; clear the flag to unresolve. Reviewers see this as the bot resolving their comment, so it is usually paired with a reply that explains what changed.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_CREATE_PR",
    "GitHub",
    "Open pull request",
    "SERVER",
    ["worktree.branch", "worktree.baseBranch"],
    ["pr.*"],
    {
      description:
        "Opens a pull request from the worktree's branch, optionally as a draft.",
      details:
        "Head branch defaults to `worktree.branch`, base to `worktree.baseBranch`, and the title to `ticket.title`. The head branch must already be pushed — put Wait for push-ready or a push operation in front of this step. Fails when a pull request is already open for the same branch pair. Writes the new pull request to `pr.*`.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_SET_PR_LABELS",
    "GitHub",
    "Set pull request labels",
    "SERVER",
    ["pr.number"],
    ["pr.labels"],
    {
      description: "Replaces the labels on a pull request with the given list.",
      details:
        "This sets rather than adds — labels not in the list are removed, so include the ones you want to keep. Labels must already exist in the repository. Writes `pr.labels`.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_RETRY_PIPELINE",
    "GitHub Actions",
    "Retry failed pipeline",
    "SERVER",
    ["pipeline.runId"],
    ["pipeline.status"],
    {
      description:
        "Re-runs the failed jobs of a check suite, leaving the jobs that passed alone.",
      details:
        "Targets a check suite rather than a single job — use Retry workflow job for that. Re-running consumes Actions minutes and re-executes whatever those jobs do, including deployments. Pair it with a Time delay and a retry limit so a permanently broken pipeline is not retried forever. Writes `pipeline.status`.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_RETRY_JOB",
    "GitHub Actions",
    "Retry workflow job",
    "SERVER",
    ["pipeline.failedJobs"],
    [],
    {
      description: "Re-runs one job of a GitHub Actions workflow run.",
      details:
        "Needs the repository, check suite, and job ids together — typically read out of `pipeline.failedJobs` inside a For each. Use Retry failed pipeline to re-run every failed job at once instead.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_CANCEL_WORKFLOW_RUN",
    "GitHub Actions",
    "Cancel workflow run",
    "SERVER",
    ["pipeline.runId"],
    ["pipeline.status"],
    {
      description: "Cancels an in-progress GitHub Actions workflow run.",
      details:
        "Falls back to `repo.id` and `pipeline.runId` from session data. Force-cancel skips the graceful shutdown that lets `always()` cleanup jobs finish, so leave it off unless a run is stuck. Cancelling a run that has already finished is an error. Writes `pipeline.status`.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_SAVE_AUTO_RETRY",
    "GitHub Actions",
    "Install auto-retry rule",
    "SERVER",
    ["pipeline.runId"],
    [],
    {
      description:
        "Saves a standing rule that automatically retries matching GitHub Actions failures.",
      details:
        "Persists configuration rather than acting once — the rule keeps applying after this run ends, and stays until something removes it. Takes the rule as a JSON object. Treat it as a settings change, not a step you re-run casually.",
      mutatesExternal: true,
    },
  ),
  step(
    "GITHUB_WAIT_CHECKS",
    "GitHub Actions",
    "Wait for checks",
    "WAIT",
    ["pipeline.runId"],
    ["pipeline.status", "pipeline.conclusion", "pipeline.jobs"],
    {
      description:
        "Parks the run until a GitHub Actions workflow run finishes, then continues on its conclusion.",
      details:
        "Polls until the run reaches a terminal status. Anything other than success fails the step, so route the failure handle to the recovery path — or set the step's failure policy to continue and branch on `pipeline.conclusion` yourself. Also refreshes `pipeline.jobs`. Without a timeout the wait is open-ended; a hung pipeline holds the workflow run indefinitely. Falls back to `repo.id` and `pipeline.runId`.",
    },
  ),
  step(
    "WORKTREE_CREATE",
    "Worktrees",
    "Create worktree",
    "SERVER",
    ["codebase.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Creates a Git worktree on the agent for a new, existing, or ticket-derived branch.",
      details:
        "Dispatches a job to the agent that owns the codebase and waits for it, so the agent must be online. Branch mode NEW cuts a branch from the base, EXISTING checks one out, and TICKET derives the name from `ticket.key`. Base branch falls back to `worktree.baseBranch` then `repo.defaultBranch`. Refreshes the created worktree, codebase, owning agent, repository, and any linked ticket. Creates real directories on disk.",
      mutatesWorktree: true,
    },
  ),
  step(
    "WORKTREE_CHANGE_BRANCH",
    "Worktrees",
    "Change worktree branch",
    "SERVER",
    ["worktree.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Switches an existing worktree to a different branch, creating it if needed.",
      details:
        'Same branch modes as Create worktree. Uncommitted changes block the switch unless "Stash on failure" is set, which stashes them and retries — the stash is left for a human to deal with. Refreshes the worktree and all of its related resource context.',
      mutatesWorktree: true,
    },
  ),
  step(
    "WORKTREE_COMMIT",
    "Worktrees",
    "Commit worktree changes",
    "SERVER",
    ["worktree.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Stages selected worktree changes and creates a Git commit on the agent.",
      details:
        "Stage all defaults on. Disable it and provide an exact list of changed paths for a partial commit; paths omitted from that list are left uncommitted. Signed commits follow effective Git configuration when the signed option is omitted. Dispatches an agent job, waits for completion, and refreshes worktree context.",
      mutatesWorktree: true,
    },
  ),
  step(
    "WORKTREE_REFRESH_PULL_REQUEST",
    "Worktrees",
    "Refresh pull request",
    "SERVER",
    ["worktree.id"],
    ["pr.*"],
    {
      description:
        "Forces exact-branch pull request discovery and refreshes the worktree's persisted pull request context.",
      details:
        "Uses the configured worktree, falling back to `worktree.id`. The step succeeds with `found: false` and clears `pr` when the branch has no open pull request.",
      mutatesWorktree: true,
      mutatesExternal: false,
    },
  ),
  step(
    "WORKTREE_OPERATION",
    "Worktrees",
    "Run worktree operation",
    "SERVER",
    ["worktree.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Runs one of the built-in worktree maintenance operations, such as syncing with the base branch or pushing.",
      details:
        "Dispatches an agent job and waits for it. Opening an editor is rejected here — it needs a human at the machine. Sync and push touch the remote and can conflict; check `worktree.pushStatus` afterwards or follow with Inspect worktree Git state.",
      mutatesWorktree: true,
    },
  ),
  step(
    "WORKTREE_SET_AUTO_SYNC",
    "Worktrees",
    "Set worktree Auto Sync",
    "SERVER",
    ["worktree.id"],
    ["worktree.autoSync"],
    {
      description:
        "Enables, updates, retries, or cancels persistent Auto Sync for a worktree.",
      details:
        "An enabled rule rebases on the target branch whenever it changes and force-pushes with lease. A merge-conflict quick-action workflow can be selected as the automatic recovery path; unresolved conflicts pause the rule.",
      mutatesWorktree: true,
      mutatesExternal: true,
    },
  ),
  step(
    "WORKTREE_SET_AUTO_MERGE",
    "Worktrees",
    "Set worktree Auto Merge",
    "SERVER",
    ["worktree.id"],
    ["worktree.autoMerge"],
    {
      description:
        "Enables, updates, retries, or cancels GitHub-native Auto Merge for a worktree.",
      details:
        "GitHub remains the authority for required checks and reviews. Optional post-merge actions can move the linked Jira ticket to its configured done status and safely delete a clean linked worktree.",
      mutatesWorktree: true,
      mutatesExternal: true,
    },
  ),
  step(
    "WORKTREE_DELETE",
    "Worktrees",
    "Delete worktree",
    "SERVER",
    ["worktree.id"],
    CODEBASE_CONTEXT_PATHS,
    {
      description:
        "Removes a worktree from the agent, optionally deleting its remote branch too.",
      details:
        "Destroys the directory and any uncommitted work in it — there is no undo. Deleting the remote branch as well affects everyone, and closes any pull request from that branch. Do not put this before steps that still read `worktree.*`.",
      mutatesWorktree: true,
    },
  ),
  step(
    "WORKTREE_MOVE",
    "Worktrees",
    "Move worktree",
    "SERVER",
    ["worktree.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Moves a worktree's branch and changes into another codebase, optionally deleting the source.",
      details:
        "Waits for the move job to finish. Used when a branch was started against the wrong checkout. Deleting the source destroys the original directory; leaving it keeps both, which means two worktrees on one branch. Refreshes `worktree.*` to point at wherever the work now lives.",
      mutatesWorktree: true,
    },
  ),
  step(
    "WORKTREE_INSPECT",
    "Worktrees",
    "Inspect worktree",
    "SERVER",
    ["worktree.id"],
    [
      "worktree.commits",
      "worktree.changes",
      "worktree.branchChanges",
      "worktree.commitsTruncated",
      "worktree.changesTruncated",
      "worktree.branchChangesTruncated",
    ],
    {
      description:
        "Reads the worktree's commits and changed files into `worktree.commits` and `worktree.changes`.",
      details:
        "Read-only. Use it to give a later condition or AI prompt something concrete to work from — for example to skip opening a pull request when nothing changed. For push/dirty state use Inspect worktree Git state instead, which is cheaper.",
    },
  ),
  step(
    "WORKTREE_INSPECT_GIT",
    "Worktrees",
    "Inspect worktree Git state",
    "SERVER",
    ["worktree.id"],
    ["worktree.*"],
    {
      description:
        "Reads the worktree's Git status — dirty flag, ahead/behind counts, push status, conflicts — into `worktree.*`.",
      details:
        "Read-only and the cheap way to branch on repository state: gate a commit on `worktree.dirty`, or a sync on the worktree being behind. Use Inspect worktree when you need the actual commits and diffs.",
    },
  ),
  step(
    "WORKTREE_GIT_OPERATION",
    "Worktrees",
    "Run worktree Git operation",
    "SERVER",
    ["worktree.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Runs a specific Git operation in the worktree — pull, push, rebase, stash, and the rest.",
      details:
        'Dispatches an agent job and waits for it. Operations that rewrite history or touch the remote can fail on conflicts; "Stash changes first" clears the way for operations that need a clean tree. Prefer Run worktree operation for the higher-level sync and push flows, which handle more of the edge cases.',
      mutatesWorktree: true,
    },
  ),
  step(
    "WORKTREE_WAIT_PUSH_READY",
    "Worktrees",
    "Wait for push-ready",
    "WAIT",
    ["worktree.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Parks the run until the worktree's branch is pushed and tracking a remote.",
      details:
        "The step to put between an AI session that commits and Open pull request, which needs the branch to exist on the remote. Resolves as soon as the branch is push-ready; without a timeout it waits indefinitely, so set one if a human may never push. Writes `worktree.pushStatus`.",
    },
  ),
  step(
    "WORKTREE_SNAPSHOT",
    "Worktrees",
    "Snapshot Git state",
    "AGENT",
    ["worktree.path"],
    ["steps.<stepId>.snapshotId"],
    {
      description:
        "Captures a restorable checkpoint of the worktree's Git state before a risky step.",
      details:
        "Runs on the agent, so it needs `worktree.path` and an online agent. The snapshot id it writes is what run replay restores from, which makes this the step to place before anything that rewrites the tree. Snapshots cost disk on the agent.",
    },
  ),
  step(
    "CODEBASE_FETCH_REFRESH",
    "Codebases",
    "Fetch or refresh codebase",
    "SERVER",
    ["codebase.id"],
    CODEBASE_CONTEXT_PATHS,
    {
      description:
        "Fetches remote refs for a codebase, or fully refreshes its cached metadata.",
      details:
        "Fetch updates remote-tracking branches; refresh re-reads the whole checkout and is slower. Runs as an agent job and waits. Fails when the agent skips the operation — usually because the codebase is missing or already busy. Put a fetch in front of steps that check whether a remote branch exists.",
      mutatesWorktree: true,
    },
  ),
  step(
    "CODEBASE_INSPECT_GIT",
    "Codebases",
    "Inspect codebase Git state",
    "SERVER",
    ["codebase.id"],
    ["codebase.*"],
    {
      description:
        "Reads the codebase checkout's Git status into `codebase.*`.",
      details:
        "Read-only. This is the primary checkout, not a worktree — use Inspect worktree Git state for per-branch work. Useful for refusing to start work when the base checkout is dirty or on an unexpected branch.",
    },
  ),
  step(
    "CODEBASE_GIT_OPERATION",
    "Codebases",
    "Run codebase Git operation",
    "SERVER",
    ["codebase.id"],
    CODEBASE_CONTEXT_PATHS,
    {
      description:
        "Runs a Git operation against the codebase's primary checkout.",
      details:
        'Same operations as the worktree version, aimed at the main checkout that every worktree branches from — so a bad rebase or reset here affects all of them. "Stash changes first" clears local modifications out of the way. Runs as an agent job and waits.',
      mutatesWorktree: true,
    },
  ),
  step(
    "BUILD_START",
    "Builds",
    "Start build or test",
    "SERVER",
    ["codebase.id", "worktree.id"],
    ["build.*"],
    {
      description:
        "Queues an iOS build, test, or archive run on the agent and waits for it to finish.",
      details:
        "Needs a build configuration id and an online agent; the destination and build scripts are optional. The step parks until the build reaches a terminal status, so a long test suite holds the workflow run. Failing builds fail the step — route the failure handle if you want to read the results anyway. Writes `build.*`, which the read-results and coverage steps then consume.",
      mutatesExternal: true,
    },
  ),
  step(
    "BUILD_READ_TEST_RESULTS",
    "Builds",
    "Read test results",
    "SERVER",
    ["build.id"],
    ["build.testSummary", "build.tests"],
    {
      description:
        "Reads a finished build's test report into `build.testSummary` and `build.tests`.",
      details:
        "Fails outright when the report is not ready, so it belongs after Start build or test rather than in parallel with it. The summary carries the passed/failed counts a condition can branch on; the per-test list is the detail an AI prompt can be pointed at. Read-only.",
    },
  ),
  step(
    "BUILD_READ_COVERAGE",
    "Builds",
    "Read code coverage",
    "SERVER",
    ["build.id"],
    [
      "build.coverageSummary",
      "build.coverageFiles",
      "build.changedCoverageFiles",
    ],
    {
      description:
        "Reads a finished build's coverage report into `build.coverageSummary` and the per-file breakdowns.",
      details:
        'Fails when the coverage report is not ready — the build must have been run with coverage collection on. Also writes the changed-files breakdown, which is what a "coverage on this branch\'s changes" gate should read rather than the whole-project number. Read-only.',
    },
  ),
  step(
    "BUILD_IMPORT_COVERAGE",
    "Builds",
    "Import coverage report",
    "SERVER",
    ["worktree.id"],
    ["build.id", "build.coverageSummary"],
    {
      description:
        "Reads a coverage file a test command wrote in the worktree and records it as a coverage report.",
      details:
        "Pair it with a Terminal command step that runs the test suite first: this step only reads what that run left behind, at the path given in `Coverage file`. The build name defaults to the workflow name and can be overridden. LCOV and Istanbul (`coverage-final.json`) are both understood, and AUTO tells them apart by the file itself. Runs as an agent job and waits. The report is attached to a new build record of its own, so it shows up on that build's coverage page and in the coverage picker on Changes; changed-line coverage is measured against the worktree's base branch, and is left out when that branch cannot be resolved. Writes the totals to `build.coverageSummary` and the new id to `build.id` — follow with Read code coverage for the per-file breakdown. Fails when the file is missing, unreadable, or describes no files.",
    },
  ),
  step(
    "BUILD_EXPORT",
    "Builds",
    "Export archive",
    "SERVER",
    ["build.id"],
    ["build.exportId", ...WORKTREE_CONTEXT_PATHS],
    {
      description:
        "Exports a finished archive build into a distributable package on the agent.",
      details:
        "Needs export settings and an archive-action build. Runs as an agent job and waits. Writes files to the agent's disk and may talk to Apple's servers for signing, so it can fail on expired certificates or provisioning profiles.",
      mutatesExternal: true,
    },
  ),
  step(
    "BUILD_DEPLOY",
    "Builds",
    "Deploy build",
    "SERVER",
    ["build.id"],
    WORKTREE_CONTEXT_PATHS,
    {
      description:
        "Installs and launches an existing build on its destinations without rebuilding.",
      details:
        "Reuses the artifacts from a previous build, so it is much faster than building again. Destinations default to the ones the build already targeted. Waits for the deployment job. This puts the app on real or simulated devices — treat it as an external effect.",
      mutatesExternal: true,
    },
  ),
  step(
    "BUILD_CANCEL",
    "Builds",
    "Cancel build",
    "SERVER",
    ["build.id"],
    ["build.id", "build.status"],
    {
      description: "Cancels a queued or running build.",
      details:
        "Aimed at a different build from the one this run started — Start build or test already waits for its own. Cancelling an already-finished build is a no-op rather than an error. Writes `build.status`.",
      mutatesExternal: true,
    },
  ),
  step(
    "DISK_SPACE_LOAD",
    "Disk space",
    "Load disk-space monitor",
    "SERVER",
    [],
    ["agent.*", "disk.*"],
    {
      description:
        "Loads the current Derived Data disk-space monitor snapshot for an agent.",
      details:
        "Targets the configured agent, then falls back to `agent.id` or `codebase.agentId`. The least-free monitored Derived Data volume supplies `disk.freeBytes`, `disk.freeGiB`, and the percentage fields; root and base-repository volumes remain in `disk.volumes` for context only. Read-only and does not request a new report.",
    },
  ),
  step(
    "DISK_SPACE_REFRESH",
    "Disk space",
    "Refresh disk-space monitor",
    "WAIT",
    [],
    ["agent.*", "disk.*"],
    {
      description:
        "Requests an immediate disk report from an agent and waits for fresh telemetry.",
      details:
        "Targets the configured agent, then falls back to `agent.id` or `codebase.agentId`. Monitoring must be enabled. The step waits until `lastReportedAt` advances, then refreshes `agent.*` and `disk.*`; by default it polls every two seconds and times out after 180 seconds.",
    },
  ),
  step(
    "DISK_SPACE_UPDATE_THRESHOLDS",
    "Disk space",
    "Update disk thresholds",
    "SERVER",
    [],
    [
      "disk.normalThresholdGiB",
      "disk.pressureThresholdGiB",
      "disk.pollIntervalSeconds",
      "disk.staleAfterSeconds",
    ],
    {
      description:
        "Updates the global normal and pressure free-space thresholds.",
      details:
        "Changes the thresholds used for every monitored agent, automatic cleanup, and admission control. The pressure threshold must be positive and lower than the normal threshold. Writes the resulting global settings into `disk.*`.",
    },
  ),
  step(
    "DISK_SPACE_SET_MONITORING",
    "Disk space",
    "Set agent disk monitoring",
    "SERVER",
    [],
    ["agent.*", "disk.*"],
    {
      description:
        "Enables or disables Derived Data disk-space monitoring for an agent.",
      details:
        "Targets the configured agent, then falls back to `agent.id` or `codebase.agentId`. Disabling monitoring also clears manual and automatic pressure mode and releases cleanup leases that have not started a job. Refreshes `agent.*` and `disk.*`.",
    },
  ),
  step(
    "DISK_SPACE_SET_PRESSURE_MODE",
    "Disk space",
    "Set disk pressure mode",
    "SERVER",
    [],
    ["agent.*", "disk.*"],
    {
      description: "Enables or clears manual disk pressure mode for an agent.",
      details:
        "Targets the configured agent, then falls back to `agent.id` or `codebase.agentId`. Manual pressure mode uses the lower pressure threshold; automatic pressure mode remains controlled by cleanup availability. Refreshes `agent.*` and `disk.*`.",
    },
  ),
  step(
    "SKILL_APPLY",
    "Skills",
    "Apply skill group",
    "SERVER",
    ["worktree.id", "repo.id"],
    ["steps.<stepId>.status"],
    {
      description:
        "Syncs a skill group's files into the target checkout, or every skill when no group is chosen.",
      details:
        "Starts a skill sync run and waits for it. Writes skill files into the repository, which shows up as uncommitted changes — commit or discard them before a step that needs a clean tree. Leave the group empty to sync everything.",
      mutatesWorktree: true,
    },
  ),
  step(
    "RUN_CREATE_PLAN",
    "AI runs",
    "Create plan and wait",
    "SERVER",
    ["worktree.id"],
    ["run.<stepId>.*"],
    {
      description:
        "Starts an AI planning run against the worktree and waits for the plan to be produced.",
      details:
        "Requires a worktree, a provider/model, and a prompt. Plans use a separate FIFO worktree queue and allow unlimited concurrent plans by default; set the worktree concurrency limit to 1–32 to cap them, or 0 for unlimited. Planning inspects the code but does not change it — use Run AI session and wait to actually make edits, or follow with Run completed plan. If the run asks a question it parks until someone answers, so pair long workflows with a question-needed trigger. Writes the run under `run.<stepId>.*`, which later steps reference by this step's id.",
    },
  ),
  step(
    "RUN_CREATE_SESSION",
    "AI runs",
    "Run AI session and wait",
    "SERVER",
    ["worktree.id"],
    ["run.<stepId>.*"],
    {
      description:
        "Starts an AI coding session against the worktree and waits for it to finish.",
      details:
        "The workhorse step: the agent edits files in the worktree, so the tree is dirty afterwards and the changes still need committing and pushing. Sessions use a separate FIFO worktree queue with one active session by default; set the worktree concurrency limit to 2–32 for parallel sessions or 0 for unlimited. Requires a worktree, a provider/model, and a prompt; attachments and web search are optional. Parks on questions until answered. Writes `run.<stepId>.*`.",
      mutatesWorktree: true,
    },
  ),
  step(
    "RUN_PLAY_PLAN",
    "AI runs",
    "Run completed plan",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description:
        "Executes a plan that has already been produced, turning it into real code changes.",
      details:
        "Takes the plan's run id — usually `run.<planStepId>.id` from an earlier Create plan step. The plan must have completed. The resulting Session joins the worktree's FIFO Session queue, which allows one active Session by default; use 0 for unlimited or 2–32 for a larger limit. This is the half of the plan/execute split that touches the worktree. Writes a new run under `run.<stepId>.*`.",
      mutatesWorktree: true,
    },
  ),
  step(
    "RUN_FOLLOW_UP",
    "AI runs",
    "Follow up run",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description:
        "Starts a new AI run that continues from an existing one, resuming its context or starting fresh.",
      details:
        'RESUME keeps the previous conversation, FRESH starts over in the same worktree, and RESEND replays the original prompt. The new run joins the source kind\'s separate FIFO worktree queue and defaults to unlimited concurrency for Plans or one active run for Sessions; use 0 for unlimited or 1–32 for a finite limit. Needs the source run id plus a new prompt. The natural step for "fix the review comments" loops after a first session. Writes `run.<stepId>.*`.',
    },
  ),
  step(
    "RUN_STEER",
    "AI runs",
    "Steer active run",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description:
        "Sends extra instructions into a run that is already in progress.",
      details:
        "Only affects a run that is still going — it does not restart a finished one, which is what Follow up run is for. Because the steps in this workflow that start runs also wait for them, steering usually targets a run started elsewhere, reached through a run trigger.",
    },
  ),
  step(
    "RUN_ANSWER",
    "AI runs",
    "Answer run question",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description:
        "Answers a question an AI run is blocked on so it can carry on.",
      details:
        "Needs the question batch id, typically from `run.questions` seeded by a run-needs-an-answer trigger, and answers keyed by question id. This answers questions asked by an AI run — the Request confirmation and Ask user to choose steps ask questions of a human about the workflow itself.",
    },
  ),
  step("RUN_PAUSE", "AI runs", "Pause run", "SERVER", [], ["run.<stepId>.*"], {
    description: "Pauses an in-progress AI run.",
    details:
      "The run stops at its next checkpoint and stays paused until something continues it. Falls back to `run.id`. Pausing an already-finished run fails.",
  }),
  step(
    "RUN_CONTINUE",
    "AI runs",
    "Continue run",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description: "Resumes a paused AI run.",
      details:
        "The counterpart to Pause run. Fails when the run is not paused. Falls back to `run.id`.",
    },
  ),
  step(
    "RUN_CANCEL",
    "AI runs",
    "Cancel run",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description: "Cancels an AI run, stopping its work.",
      details:
        "Whatever the run already wrote to the worktree stays — cancelling stops further work, it does not roll anything back. Falls back to `run.id`.",
    },
  ),
  step(
    "RUN_REVISE_ANSWER",
    "AI runs",
    "Revise answer and rewind",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description:
        "Rewinds a run to an earlier question, replaces the answer, and replays from there.",
      details:
        "Two-phase: the step prepares the revision, parks, and applies it once the run is ready. Rolling back restores the worktree to the checkpoint at that question, discarding work done since — stash first if that work matters. The heavy way to correct a wrong answer; Follow up run is usually enough.",
      mutatesWorktree: true,
    },
  ),
  step(
    "RUN_READ_RESULT",
    "AI runs",
    "Read run result",
    "SERVER",
    [],
    ["run.<stepId>.*"],
    {
      description:
        "Loads a finished run's events, questions, token usage, and linked items into session data.",
      details:
        "Read-only. Gives later steps the run's actual output to work from — a summary to put in a Jira comment, usage figures to threshold on, or the linked pull request. Falls back to `run.id`.",
    },
  ),
  step(
    "RUN_CAPTURE_CHECKPOINT",
    "AI runs",
    "Capture run checkpoint",
    "SERVER",
    [],
    ["steps.<stepId>.snapshotId"],
    {
      description:
        "Records the run's most recent checkpoint so a later replay can restore from it.",
      details:
        "Reads an existing checkpoint rather than creating one, and fails when the run has none. Use Snapshot Git state to capture a fresh checkpoint of the worktree instead. Writes the checkpoint id to `steps.<stepId>.snapshotId`.",
    },
  ),
  step(
    "RUN_ARCHIVE_DELETE",
    "AI runs",
    "Archive or delete run",
    "SERVER",
    [],
    [],
    {
      description:
        "Archives a run out of the active list, or permanently deletes it.",
      details:
        "Archiving is reversible; deleting removes the run and its history for good. Delete wins when both flags are set. Housekeeping for workflows that generate many short-lived runs.",
      mutatesExternal: true,
    },
  ),
  step(
    "NOTIFICATION_SEND",
    "Human loop",
    "Send notification",
    "SERVER",
    [],
    [],
    {
      description:
        "Posts a notification into the app's notification list with a title, body, and link.",
      details:
        "Deduplicated per run, step, and generation, so a retried attempt does not notify twice. The link defaults to this workflow run. Fire-and-forget: it tells a human something happened but does not wait — use Request confirmation when the workflow needs an answer.",
      mutatesExternal: true,
    },
  ),
  step("IOS_PUSH_SEND", "Human loop", "Push to iOS device", "SERVER", [], [], {
    description:
      "Sends an Apple push notification to registered devices, a broadcast channel, or one raw device token.",
    details:
      "Needs APNs credentials. Target mode picks between all registrations, a chosen few, a broadcast channel, or a direct token — the direct mode also needs the token's encoding and whether it is a sandbox or production token. Leaves the device once delivered; nothing about the run waits on it.",
    mutatesExternal: true,
  }),
  step(
    "HUMAN_CONFIRM",
    "Human loop",
    "Request confirmation",
    "WAIT",
    [],
    ["steps.<stepId>.answer"],
    {
      description:
        "Parks the run and asks a human to confirm before continuing.",
      details:
        "The approval gate to put in front of anything irreversible. Without a timeout the run waits indefinitely; with one it fails when nobody answers in time, which the failure handle can route to a safe default. The answer lands in `steps.<stepId>.answer`.",
    },
  ),
  step(
    "HUMAN_CHOICE",
    "Human loop",
    "Ask user to choose",
    "WAIT",
    [],
    ["steps.<stepId>.answer"],
    {
      description:
        "Parks the run and asks a human to pick from a set of options, optionally allowing several or a free-text answer.",
      details:
        "Like Request confirmation but with named buttons — branch on `steps.<stepId>.answer` with an If step afterwards. Multi-select returns a list. Allowing a custom answer means the value may be anything the person typed, so handle the unexpected case.",
    },
  ),
  step("CONTROL_IF", "Control flow", "If / else", "CONTROL", [], [], {
    description:
      "Evaluates a condition and sends the run down its `true` or `false` branch.",
    details:
      "Exactly one branch is taken; steps on the other are skipped, and a skipped branch does not block a downstream join. Conditions compare session values with the usual operators and combine with ALL/ANY/NOT. Both branches may be left unconnected, which simply ends that path.",
  }),
  step("CONTROL_JOIN", "Control flow", "Join branches", "CONTROL", [], [], {
    description:
      "Brings parallel branches back together, waiting for all of them or continuing on the first.",
    details:
      "Required wherever more than one branch reaches the same step — the validator rejects a plain step with several incoming edges. ALL waits for every branch, ANY continues on the first and lets the others keep running. Skipped branches never block it, and the join is skipped when no branch reaches it. A join that closes a For each also reports the iteration failures.",
  }),
  step("CONTROL_DELAY", "Control flow", "Time delay", "WAIT", [], [], {
    description: "Pauses the run for a fixed number of seconds.",
    details:
      "Accepts up to a year. The run is parked rather than held open, so a long delay costs nothing while it waits. Use it to space out polling or to give an external system time to settle; use Wait until when you are waiting for a condition rather than a duration.",
  }),
  step("CONTROL_WAIT_UNTIL", "Control flow", "Wait until", "WAIT", [], [], {
    description:
      "Parks the run until a condition over session data becomes true, re-checking on a cadence.",
    details:
      "Evaluates immediately and continues at once if the condition already holds. Session data only changes when a step writes it, so the condition must be able to become true through some other branch — otherwise the wait never resolves. Default cadence is 15 seconds; set a timeout to bound it.",
  }),
  step(
    "CONTROL_FOR_EACH",
    "Control flow",
    "For each",
    "CONTROL",
    [],
    ["steps.<stepId>.items"],
    {
      description:
        "Runs its `body` branch once per item in a list, or takes the `empty` branch when there is nothing to iterate.",
      details:
        "Reads the list from a session path or from inline items, and caps at 1,000. Iterations run in parallel and each sees its own item. Fail-fast stops the whole run on the first failing iteration; collect-errors lets them all finish and reports failures at the closing join. Writes the items to `steps.<stepId>.items`.",
    },
  ),
  step("CONTROL_TRY", "Control flow", "Try / catch", "CONTROL", [], [], {
    description:
      "Marks the start of a protected region whose failures route out of the `catch` handle.",
    details:
      "Takes no config — the recovery path is drawn in the graph. Steps on the `success` branch run normally; when one of them fails, the run continues from `catch` instead of failing outright. Use a step's own failure handle for a single fallible step; reach for this when a whole sequence shares one recovery path.",
  }),
  step(
    "CONTROL_SET_VARIABLE",
    "Control flow",
    "Set or compute variable",
    "CONTROL",
    [],
    [],
    {
      description:
        "Writes a value into session data at a chosen path, either a constant or the result of a small script.",
      details:
        "The script runs in a sandboxed JavaScript interpreter with the session data available and no network or filesystem access; its return value is what gets written. Without a script the literal value is used. The path may be any dotted path — write under a namespace of your own to avoid colliding with what steps produce. Because the path comes from config, the catalog cannot advertise it: list it in this step's own `providedPaths` too, or a later step that binds it fails to publish with REQUIREMENT_UNSATISFIED.",
    },
  ),
  step(
    "CONTROL_SUBWORKFLOW",
    "Control flow",
    "Call sub-workflow",
    "SERVER",
    [],
    [],
    {
      description:
        "Runs another published workflow as a child and waits for it to finish.",
      details:
        "Must pin a specific published version — the validator rejects an unpinned reference, so a sub-workflow cannot change under a caller. The input mapping seeds the child's session data. The child appears as a nested run; its failure fails this step.",
    },
  ),
  step(
    "SAVED_COMMAND",
    "Extensibility",
    "Run saved command",
    "AGENT",
    [],
    ["steps.<stepId>.*"],
    {
      description:
        "Starts a saved command on an eligible agent home or worktree target.",
      details:
        "Uses the saved command snapshot, target rules, output log, and restart policy. Wait for exit fails the workflow when the command ultimately fails or is cancelled; fire and forget succeeds after durable dispatch and remains independent if the workflow is later cancelled. An optional RE2 output pattern emits the match connector before exit and records captures in session data; matching requires wait for exit. Always-restart commands can only use fire and forget.",
      mutatesWorktree: true,
    },
  ),
  step(
    "CUSTOM_COMMAND",
    "Extensibility",
    "Run custom command",
    "AGENT",
    [],
    ["steps.<stepId>.*"],
    {
      description:
        "Runs a one-off shell command on an agent home or worktree and records it in Commands run history.",
      details:
        "The script is retained only in the immutable command-run snapshot, not as a reusable saved command. Context targeting prefers the current worktree, then the current agent. Wait for exit fails the workflow when the command fails or is cancelled; fire and forget succeeds after durable dispatch. An optional RE2 output pattern emits the match connector before exit and records captures in session data; matching requires wait for exit.",
      mutatesWorktree: true,
    },
  ),
  ...EXPANSION_STEP_CATALOG,
  step(
    "TERMINAL_RUN",
    "Extensibility",
    "Run terminal script",
    "AGENT",
    ["worktree.path"],
    ["steps.<stepId>.*"],
    {
      description:
        "Runs a shell or Node script on the agent inside the worktree, capturing its output.",
      details:
        "Needs `worktree.path` and an online agent. A non-zero exit fails the step. Named credentials can be injected as environment variables so secrets never sit in the definition — the validator rejects secret-looking literals in config. Arbitrary code on the agent's machine: it can change anything the agent user can reach. Writes stdout, stderr, and the exit code under `steps.<stepId>.*`; to publish anything else the script produces into a named path, declare it in this step's own `providedPaths`.",
      mutatesWorktree: true,
    },
  ),
  step(
    "MCP_CALL",
    "Extensibility",
    "Call MCP tool",
    "SERVER",
    [],
    ["steps.<stepId>.output"],
    {
      description:
        "Calls a tool on a configured MCP server — built-in or external — with a JSON argument object.",
      details:
        "The general escape hatch to anything reachable over MCP. Needs the server (tool group) and the exact tool name; arguments must match that tool's own schema. What it does depends entirely on the tool, so treat it as externally mutating. The result lands in `steps.<stepId>.output`.",
      mutatesExternal: true,
    },
  ),
];

export const WORKFLOW_STEP_BY_KIND = new Map(
  WORKFLOW_STEP_CATALOG.map((entry) => [entry.kind, entry]),
);

export type WorkflowTriggerCatalogEntry = {
  kind: WorkflowTriggerKind;
  category: string;
  label: string;
  /** One or two sentences: when this trigger fires. Shown in the editor palette. */
  description: string;
  /** The long form: what has to be configured, how matching works, what it seeds. */
  details: string;
  configSchema: Record<string, unknown>;
  capabilityFlags: string[];
  seedPaths: string[];
  /** Outgoing handle ids, for the triggers whose handles are fixed. */
  sourceHandles: string[];
};

/**
 * The session data `WorkflowEventBridge.observeRun` seeds for every run
 * lifecycle trigger. All run-based kinds (RUN_STARTED, RUN_FAILED,
 * RUN_COMPLETED, RUN_CANCELLED, …) share the same `sessionData` object, so
 * they must advertise the same seed paths — otherwise a trigger like
 * RUN_FAILED appears to provide less than RUN_STARTED even though the bridge
 * hands both identical data.
 */
const RUN_SEED_PATHS = [
  "run.*",
  "worktree.*",
  "codebase.*",
  "agent.*",
  "repo.*",
  "ticket.*",
];

/** Context shared by build events when the build belongs to a worktree. */
const BUILD_SEED_PATHS = [
  "build.*",
  "worktree.*",
  "codebase.*",
  "agent.*",
  "repo.*",
  "ticket.*",
];

/** Context shared by every event emitted for a worktree. */
const WORKTREE_SEED_PATHS = [
  "worktree.*",
  "codebase.*",
  "agent.*",
  "repo.*",
  "ticket.*",
  "pr.*",
];

/** Jira observations include the latest comment and webhook changelog. */
const JIRA_SEED_PATHS = ["ticket.*", "comment.*", "changelog.*"];

/** Shared payload for pull-request webhook triggers. */
const GITHUB_PULL_REQUEST_SEED_PATHS = [
  "repo.*",
  "pr.*",
  "ticket.*",
  "worktree.*",
  "codebase.*",
  "agent.*",
];

/** Pull-request comment/review triggers additionally expose the comment. */
const GITHUB_COMMENT_SEED_PATHS = [
  ...GITHUB_PULL_REQUEST_SEED_PATHS,
  "comment.*",
];

/** Issue comments may target a plain issue, so no worktree is guaranteed. */
const GITHUB_ISSUE_COMMENT_SEED_PATHS = [
  "repo.*",
  "pr.*",
  "ticket.*",
  "comment.*",
];

/** Shared closing note for every trigger that supports the `filters` map. */
const FILTERS_NOTE =
  "Filters narrow it further: each session path must equal the given value, or be one of a list of values.";

/** Shared closing note for the threshold triggers. */
const THRESHOLD_NOTE =
  "Set a threshold path, operator, and value to fire only on the crossing: it fires when the comparison first becomes true and stays quiet until it goes false again, so a metric hovering over the line does not fire repeatedly.";

const trigger = (
  kind: WorkflowTriggerKind,
  category: string,
  label: string,
  seedPaths: string[],
  facts: { description: string; details: string },
): WorkflowTriggerCatalogEntry => ({
  kind,
  category,
  label,
  description: facts.description,
  details: facts.details,
  configSchema: configSchemaForKind(kind, "trigger"),
  capabilityFlags: ["DURABLE", "DEDUPLICATED"],
  seedPaths,
  sourceHandles: workflowStaticSourceHandles(kind),
});

const expansionTrigger = (
  kind: WorkflowTriggerKind,
  category: string,
  label: string,
  seedPaths: string[],
): WorkflowTriggerCatalogEntry =>
  trigger(kind, category, label, seedPaths, {
    description: `${label} emits a normalized, filterable workflow event.`,
    details: `${label} uses the canonical domain event and deduplicates deliveries by subject and revision. ${FILTERS_NOTE}`,
  });

const EXPANSION_TRIGGER_CATALOG: WorkflowTriggerCatalogEntry[] = [
  expansionTrigger("COMMAND_RUN_RESULT", "Commands", "Command run result", [
    "command.*",
    "agent.*",
    "worktree.*",
  ]),
  expansionTrigger("COMMAND_OUTPUT_MATCH", "Commands", "Command output match", [
    "command.*",
    "output.*",
  ]),
  expansionTrigger("SKILL_SYNC_RESULT", "Skills", "Skill sync result", [
    "skillSync.*",
    "skill.*",
    "repo.*",
  ]),
  expansionTrigger("SKILL_SYNC_CONFLICT", "Skills", "Skill sync conflict", [
    "skillSync.*",
    "skill.*",
    "repo.*",
  ]),
  expansionTrigger(
    "GITHUB_PIPELINE_STATUS_CHANGED",
    "GitHub",
    "Pipeline status changed",
    [
      "pipeline.*",
      "repo.*",
      "pr.*",
      "worktree.*",
      "codebase.*",
      "agent.*",
      "ticket.*",
    ],
  ),
  expansionTrigger(
    "GITHUB_PR_SYNCHRONIZED",
    "GitHub",
    "Pull request synchronized",
    GITHUB_PULL_REQUEST_SEED_PATHS,
  ),
  expansionTrigger(
    "GITHUB_REVIEW_APPROVED",
    "GitHub",
    "Pull request review approved",
    GITHUB_PULL_REQUEST_SEED_PATHS,
  ),
  expansionTrigger(
    "JIRA_TICKET_UPDATED",
    "Jira",
    "Jira ticket updated",
    JIRA_SEED_PATHS,
  ),
  expansionTrigger(
    "JIRA_COMMENT_ADDED",
    "Jira",
    "Jira comment added",
    JIRA_SEED_PATHS,
  ),
  expansionTrigger(
    "JIRA_WORKLOG_ADDED",
    "Jira",
    "Jira worklog added",
    JIRA_SEED_PATHS,
  ),
  expansionTrigger(
    "JIRA_SPRINT_ENDED",
    "Jira",
    "Jira sprint ended",
    JIRA_SEED_PATHS,
  ),
  expansionTrigger(
    "CODEBASE_SYNC_STATE_CHANGED",
    "Codebases",
    "Codebase sync state changed",
    ["codebase.*", "agent.*", "repo.*"],
  ),
  expansionTrigger(
    "CODEBASE_OPERATION_FAILED",
    "Codebases",
    "Codebase operation failed",
    ["codebase.*", "agent.*", "repo.*", "operation.*"],
  ),
  expansionTrigger(
    "WORKTREE_SYNC_STATE_CHANGED",
    "Worktrees",
    "Worktree sync state changed",
    WORKTREE_SEED_PATHS,
  ),
  expansionTrigger(
    "WORKTREE_AUTOMATION_RESULT",
    "Worktrees",
    "Worktree automation result",
    [...WORKTREE_SEED_PATHS, "automation.*"],
  ),
  expansionTrigger(
    "WORKTREE_CLEAN",
    "Worktrees",
    "Worktree became clean",
    WORKTREE_SEED_PATHS,
  ),
  expansionTrigger(
    "PUSH_NOTIFICATION_RESULT",
    "Notifications",
    "Push notification result",
    ["pushBatch.*"],
  ),
  expansionTrigger("IOS_DEVICE_ENROLLED", "Devices", "iOS device enrolled", [
    "device.*",
  ]),
  expansionTrigger(
    "IOS_DEVICE_REGISTRATION_RESULT",
    "Devices",
    "iOS device registration result",
    ["device.*"],
  ),
  expansionTrigger(
    "SIGNING_OPERATION_RESULT",
    "Signing",
    "Signing operation result",
    ["signing.*", "signingProfile.*", "agent.*"],
  ),
  expansionTrigger(
    "SIGNING_ASSET_EXPIRING",
    "Signing",
    "Signing asset expiring",
    ["signing.*", "signingProfile.*", "agent.*"],
  ),
  expansionTrigger(
    "BUILD_DATA_THRESHOLD",
    "Build Data",
    "Build-data threshold",
    ["buildData.*", "agent.*", "worktree.*"],
  ),
  expansionTrigger(
    "BUILD_DATA_CLEANUP_RESULT",
    "Build Data",
    "Build-data cleanup result",
    ["buildData.*", "cleanup.*", "agent.*"],
  ),
  expansionTrigger(
    "POLLING_OPERATION_STATE",
    "Operations",
    "Polling operation state",
    ["polling.*"],
  ),
  expansionTrigger(
    "MODEL_COST_CATALOG_CHANGED",
    "Operations",
    "Model-cost catalog changed",
    ["modelCosts.*"],
  ),
  expansionTrigger(
    "CREDENTIAL_STORE_DEGRADED",
    "Operations",
    "Credential store degraded",
    ["credentials.*"],
  ),
  expansionTrigger(
    "AGENT_RESOURCE_THRESHOLD",
    "Agents",
    "Agent resource threshold",
    ["agent.*"],
  ),
  expansionTrigger("AGENT_VERSION_CHANGED", "Agents", "Agent version changed", [
    "agent.*",
  ]),
  expansionTrigger("TOOL_CALL_RESULT", "Tools", "Tool call result", [
    "toolCall.*",
  ]),
];

export const WORKFLOW_TRIGGER_CATALOG: readonly WorkflowTriggerCatalogEntry[] =
  [
    trigger("MANUAL", "Manual", "Manual run", [], {
      description:
        "Fires when someone presses Run on the workflow. The default entry point.",
      details:
        "Seeds nothing beyond `workflow.*`, so steps hanging off it can only bind to values that later steps produce. A caller may still pass session data explicitly when starting the run. A workflow that has only a choice trigger refuses a plain run.",
    }),
    trigger("MANUAL_CHOICE", "Manual", "Manual run with a choice", [], {
      description:
        "Fires when someone picks an option from the menu under the run button, and routes the run out of that option's own handle.",
      details:
        "Declare at least one option, each with a unique key — the key names the outgoing handle, so renaming a label leaves edges attached. One workflow can fan out into several entry paths without a step in front of them. Every edge must leave a handle that still exists, or publishing fails.",
    }),
    // Seed paths are derived per-trigger from the configured resource kind
    // (see `resourceManualSeedPaths`), not declared statically here.
    trigger("RESOURCE_MANUAL", "Manual", "Run from a resource", [], {
      description:
        "Fires when someone starts the workflow from a specific resource page — a worktree, pull request, build, codebase, ticket, or run.",
      details:
        "Must target exactly one resource kind; add a second trigger to accept another. The page seeds that resource's namespace into session data, so a worktree-launched run gets its worktree, codebase, owning agent, repository, and any linked ticket. Those seeds are an optimistic contract — an optional link that is absent resolves to nothing at run time. A worktree does not seed `pr.*`; use a pull-request trigger or Load pull request to bring one into session data. This is also what makes the workflow show up on that resource's page.",
    }),
    trigger(
      "RESOURCE_MANUAL_CHOICE",
      "Manual",
      "Run from a resource with a choice",
      [],
      {
        description:
          "Fires from a resource page after the person picks an option, routing out of that option's handle.",
        details:
          "The resource and choice triggers combined: pick a resource kind and declare keyed options. Same rules as both — one resource kind per trigger, unique option keys, and every edge on a live handle.",
      },
    ),
    trigger("SCHEDULE", "Schedule", "On a schedule", [], {
      description: "Fires repeatedly on a fixed cadence measured in seconds.",
      details:
        'A cadence, not a cron expression — there is no way to say "weekdays at 9am". The clock runs while the workflow is enabled, and pausing the workflow stops it. Seeds nothing, so scheduled workflows normally start by loading whatever they operate on. Mind the overlap policy: a cadence shorter than the run takes will queue or coalesce.',
    }),
    trigger(
      "WORKFLOW_FINISHED",
      "Workflows",
      "Another workflow finished",
      ["workflow.*"],
      {
        description:
          "Fires when a different workflow run reaches a terminal state.",
        details: `Chains workflows without making one a sub-workflow of the other, so the two stay independently runnable. Filter on \`workflow.id\` to watch a specific one and on the finishing status to react only to failures. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_PR_STATE",
      "GitHub",
      "Pull request opened or ready",
      GITHUB_PULL_REQUEST_SEED_PATHS,
      {
        description:
          "Fires when a pull request is opened, or when a draft is marked ready for review.",
        details: `Needs GitHub polling configured for the repository. Seeds \`pr.*\` and \`repo.*\`, so steps can act on the pull request straight away. ${FILTERS_NOTE} Filter on \`pr.isDraft\` or the base branch to avoid firing on every pull request in the repository.`,
      },
    ),
    trigger(
      "GITHUB_REVIEW_CHANGES_REQUESTED",
      "GitHub",
      "Changes requested",
      GITHUB_PULL_REQUEST_SEED_PATHS,
      {
        description:
          "Fires when a reviewer submits a review requesting changes.",
        details: `The entry point for an automated \"address the review\" loop: pair it with Collect review comments and an AI session. Approvals and plain comments do not fire it. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_REVIEW_COMMENT",
      "GitHub",
      "Review comment created",
      GITHUB_COMMENT_SEED_PATHS,
      {
        description:
          "Fires when a new review comment is posted on a pull request.",
        details: `Fires per comment rather than per review, so a reviewer leaving five comments fires it five times — take care with steps that start AI runs. Use Changes requested when you want one event per review. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_PR_CLOSED",
      "GitHub",
      "Pull request merged or closed",
      GITHUB_PULL_REQUEST_SEED_PATHS,
      {
        description:
          "Fires when a pull request is merged or closed without merging.",
        details: `Both outcomes fire it; branch on \`pr.state\` to tell them apart. The natural place to hang cleanup — deleting the worktree, moving the ticket on. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_CHECK_FAILED",
      "GitHub",
      "Check suite or run failed",
      [
        "repo.*",
        "pipeline.*",
        "worktree.*",
        "codebase.*",
        "agent.*",
        "pr.*",
        "ticket.*",
      ],
      {
        description: "Fires when a check suite or check run reports a failure.",
        details: `Seeds \`pipeline.*\`, including the ids the retry and cancel steps need. Flaky suites fire this often, so gate an automatic retry on a count or a delay rather than retrying unconditionally. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_PUSH_DEFAULT",
      "GitHub",
      "Push to default branch",
      ["repo.*", "push.*", "ticket.*"],
      {
        description:
          "Fires when a commit lands on the repository's default branch.",
        details: `Seeds \`repo.*\` and \`push.*\`, plus a ticket key when the pushed branch contains one. There is no pull request or worktree in scope, so a workflow hanging off it usually starts by creating one. Fires on merges too, since a merge is a push. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_WORKFLOW_SUCCEEDED",
      "GitHub",
      "Workflow run succeeded",
      [
        "repo.*",
        "pipeline.*",
        "worktree.*",
        "codebase.*",
        "agent.*",
        "pr.*",
        "ticket.*",
      ],
      {
        description:
          "Fires when a GitHub Actions workflow run completes successfully.",
        details: `The success counterpart to the failure triggers — useful for gating a deploy or a merge on a green pipeline. Filter on the workflow name so every unrelated Actions run does not start this workflow. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_ISSUE_COMMAND",
      "GitHub",
      "Issue comment command",
      GITHUB_ISSUE_COMMENT_SEED_PATHS,
      {
        description:
          "Fires when a comment from an allow-listed GitHub user matches a command pattern, such as `/deploy`.",
        details: `The only trigger that lets outside text start a workflow, so it is deliberately strict: an explicit list of GitHub logins is required, and the pattern must be anchored with \`^\` and \`$\` — publishing fails otherwise. Both checks must pass. Keep the allow-list tight, since anyone on it can start whatever the workflow does. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_ACTIONS_RESULT",
      "GitHub Actions",
      "Workflow result",
      [
        "repo.*",
        "pipeline.*",
        "worktree.*",
        "codebase.*",
        "agent.*",
        "pr.*",
        "ticket.*",
      ],
      {
        description:
          "Fires when a tracked GitHub Actions run finishes, whatever its conclusion.",
        details: `The richest of the Actions triggers: it correlates the run back to its worktree, owning agent, pull request, and ticket when those links exist. Branch on the conclusion rather than adding separate success and failure triggers. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "GITHUB_PR_LABEL",
      "GitHub",
      "Pull request label set",
      GITHUB_PULL_REQUEST_SEED_PATHS,
      {
        description: "Fires when a label is applied to a pull request.",
        details: `Turns a label into a manual switch — label a pull request \`automerge\` and let a workflow take it from there. Filter on the label name, or every label change in the repository starts the workflow. ${FILTERS_NOTE}`,
      },
    ),
    trigger("BUILD_RESULT", "Builds", "Build result", BUILD_SEED_PATHS, {
      description: "Fires when a build finishes, succeeded or failed.",
      details: `Seeds \`build.*\` along with the worktree it ran in, so the read-results and coverage steps can follow directly. Branch on \`build.status\` to separate the outcomes. ${FILTERS_NOTE}`,
    }),
    trigger(
      "BUILD_TEST_THRESHOLD",
      "Builds",
      "Test failure threshold",
      BUILD_SEED_PATHS,
      {
        description:
          "Fires when a build's failing-test count crosses a threshold you set.",
        details: `Point the threshold path at \`build.testSummary.failed\` and pick an operator and value. ${THRESHOLD_NOTE} ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "BUILD_COVERAGE_THRESHOLD",
      "Builds",
      "Coverage threshold",
      BUILD_SEED_PATHS,
      {
        description:
          "Fires when a build's code coverage crosses a threshold you set.",
        details: `Point the threshold path at the coverage summary — usually the changed-files percentage rather than the whole-project number — and compare with a less-than operator. ${THRESHOLD_NOTE} ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "BUILD_HOOK_FAILED",
      "Builds",
      "Build hook failed",
      BUILD_SEED_PATHS,
      {
        description:
          "Fires when one of a build's pre- or post-build scripts fails.",
        details: `Distinguishes a broken build script from a genuine compile or test failure, which is what Build result reports. Seeds \`build.*\`. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "AGENT_CONNECTION",
      "Agents",
      "Agent connection changed",
      ["agent.*", "codebase.agentId"],
      {
        description: "Fires when an agent comes online or goes offline.",
        details: `Seeds the agent id, name, connection state, and capacity metrics. A workflow hanging off it is usually about notifying a human rather than doing repository work — an offline agent cannot run agent steps anyway. Filter on the connection status to react to one direction only. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "AGENT_JOB_FAILED",
      "Agents",
      "Agent job failed",
      [
        "steps.trigger.*",
        "agent.*",
        "codebase.*",
        "worktree.*",
        "repo.*",
        "ticket.*",
      ],
      {
        description:
          "Fires when a job dispatched to an agent fails — a build, a Git operation, a terminal script.",
        details: `The failing job is seeded under \`steps.trigger.*\`, including its kind and error. When it targeted a worktree, the owning agent, codebase, repository, and ticket are included too. Catches infrastructure failures that a workflow's own failure handles never see, because the job belonged to a different run. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "AGENT_DISK_REPORT",
      "Agents",
      "Agent disk report",
      ["agent.*", "codebase.agentId", "disk.*"],
      {
        description:
          "Fires whenever the Derived Data monitor accepts a new agent disk report.",
        details: `Seeds the complete monitor snapshot under \`disk.*\`, while \`agent.diskFreeBytes\` remains the legacy root-disk inventory value. This can fire at the agent poll cadence; use filters when every report is not needed. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "AGENT_DISK_THRESHOLD",
      "Agents",
      "Agent disk threshold",
      ["agent.*", "codebase.agentId", "disk.*"],
      {
        description:
          "Fires when monitored Derived Data free space crosses a threshold you set.",
        details: `Use \`disk.freeGiB\`, \`disk.freeBytes\`, or \`disk.freePercent\` to evaluate the least-free monitored Derived Data volume. \`agent.diskFreeBytes\` remains available for older root-disk workflows. ${THRESHOLD_NOTE} ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "AGENT_DISK_STATE_CHANGED",
      "Agents",
      "Agent disk state changed",
      ["agent.*", "codebase.agentId", "disk.*"],
      {
        description:
          "Fires when an agent's disk monitor changes status, pressure mode, health, or monitored volume.",
        details: `Filter on \`disk.status\`, \`disk.pressureMode\`, \`disk.enabled\`, or errors and warnings to react to a specific transition. Cleanup start appears as \`DELETING\`; recovery can be selected with \`IDLE\`. Repeated reports in the same state stay quiet. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "AGENT_DISK_CLEANUP_RESULT",
      "Agents",
      "Automatic disk cleanup result",
      ["agent.*", "codebase.agentId", "disk.*", "cleanup.*"],
      {
        description:
          "Fires whenever a monitor-managed automatic Derived Data cleanup finishes.",
        details: `Seeds the terminal agent job under \`cleanup.*\`, including status, error, targets, and deleted entries. Every cleanup job is independent, so two successive successes both fire. Manual Build Data deletions remain outside this trigger. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "CCUSAGE_THRESHOLD",
      "Agents",
      "Usage threshold",
      ["run.usage.*", "agent.*"],
      {
        description:
          "Fires when aggregate AI usage crosses a threshold you set.",
        details: `Watches usage across runs rather than one run's spend — Run usage threshold does that. The cost guardrail: notify, or pause workflows that start AI runs. ${THRESHOLD_NOTE} ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "WORKTREE_CREATED",
      "Worktrees",
      "Worktree created",
      WORKTREE_SEED_PATHS,
      {
        description: "Fires after a new worktree is successfully created.",
        details: `Fires once after the created worktree is projected into the control plane. Seeds the worktree, repository, codebase, and owning agent, plus a linked pull request and Jira ticket when the branch resolves to them. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "WORKTREE_BEHIND",
      "Worktrees",
      "Worktree behind base",
      WORKTREE_SEED_PATHS,
      {
        description:
          "Fires when a worktree's branch falls behind the branch it was cut from.",
        details: `Pairs with a sync operation to keep long-lived branches current. Fires again as the base moves on, so a workflow that reacts should either sync or be filtered narrowly. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "WORKTREE_CONFLICT",
      "Worktrees",
      "Worktree has conflicts",
      WORKTREE_SEED_PATHS,
      {
        description:
          "Fires when a worktree is left with Git conflicts after a merge or rebase.",
        details: `Only fires when the worktree is genuinely marked conflicted. Conflicts need resolving before most other worktree steps will work, so this usually leads to a notification or an AI session pointed at the conflict. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "WORKTREE_MISSING",
      "Worktrees",
      "Worktree missing",
      WORKTREE_SEED_PATHS,
      {
        description:
          "Fires when a worktree the control plane knows about is no longer on disk.",
        details: `Only fires once the worktree is actually recorded as missing — usually someone deleted the directory by hand, or the agent's disk was cleaned. Steps that need the worktree will fail, so react by recreating it or clearing the record. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "WORKTREE_DIVERGED",
      "Worktrees",
      "Worktree diverged",
      WORKTREE_SEED_PATHS,
      {
        description:
          "Fires when a worktree's branch and its remote have both moved on independently.",
        details: `Only fires when the push status is genuinely diverged. Resolving it means a rebase, a merge, or a force push — all destructive enough that this usually routes to a human rather than to an automatic fix. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "WORKTREE_DIRTY_DURATION",
      "Worktrees",
      "Worktree dirty too long",
      WORKTREE_SEED_PATHS,
      {
        description:
          "Fires when a worktree has had uncommitted changes for longer than expected.",
        details: `Catches work that stalled — an AI session that edited files and was never followed up, or a human who wandered off. Usually a nudge rather than an automatic commit. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "WORKTREE_NEW_COMMIT",
      "Worktrees",
      "New worktree commit",
      WORKTREE_SEED_PATHS,
      {
        description: "Fires when a new commit lands in a worktree.",
        details: `Fires per commit, so a rebase or a batch of commits fires it repeatedly — keep the reaction cheap, or filter to one branch. Useful for kicking off a build or lint pass as work lands. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "CODEBASE_REMOTE_BRANCH",
      "Codebases",
      "Matching remote branch",
      ["codebase.*", "agent.*", "repo.*"],
      {
        description:
          "Fires when a remote branch matching the codebase's conventions appears.",
        details: `Lets a branch pushed from elsewhere pull work into this system — creating a worktree for it, or opening a pull request. Needs a fetch to have run for the branch to be visible. ${FILTERS_NOTE}`,
      },
    ),
    trigger("JIRA_STATUS", "Jira", "Ticket status changed", JIRA_SEED_PATHS, {
      description: "Fires when a Jira ticket moves to another status.",
      details: `Needs Jira polling configured. Seeds \`ticket.*\`. Filter on \`ticket.status\` to react to one column only — without a filter, every transition on every polled ticket starts the workflow. ${FILTERS_NOTE}`,
    }),
    trigger("JIRA_LABEL", "Jira", "Jira label set", JIRA_SEED_PATHS, {
      description: "Fires when a label is applied to a Jira ticket.",
      details: `The Jira counterpart to the pull request label trigger: a label becomes a manual switch for automation. Filter on the label name. ${FILTERS_NOTE}`,
    }),
    trigger(
      "JIRA_ASSIGNED_SELF",
      "Jira",
      "Ticket assigned to me",
      JIRA_SEED_PATHS,
      {
        description:
          "Fires when a ticket is assigned to the account behind the configured Jira credential.",
        details: `\"Me\" is whoever the Jira credential authenticates as, not whoever is looking at the screen. The usual start of a \"pick up my next ticket\" workflow — create a worktree, start a plan. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "JIRA_SOURCE_NEW_TICKET",
      "Jira",
      "New ticket in source",
      JIRA_SEED_PATHS,
      {
        description:
          "Fires when a ticket appears in a configured Jira source — a saved JQL query or board.",
        details: `Fires on tickets newly matching the source, which includes existing tickets edited into range, not only freshly created ones. The source itself does the filtering, so keep its JQL tight. Seeds \`ticket.*\`. ${FILTERS_NOTE}`,
      },
    ),
    trigger("JIRA_MENTION", "Jira", "Jira comment mention", JIRA_SEED_PATHS, {
      description:
        "Fires when the configured Jira account is mentioned in a ticket comment.",
      details: `Lets someone pull automation into a conversation by mentioning the bot. The comment is seeded under \`comment.*\`, so an AI step can read what was actually asked — treat that text as untrusted input rather than instructions. ${FILTERS_NOTE}`,
    }),
    trigger("JIRA_SPRINT_STARTED", "Jira", "Sprint started", JIRA_SEED_PATHS, {
      description: "Fires when a Jira sprint is started.",
      details: `Fires per ticket in the sprint, so a sprint of thirty tickets starts thirty runs — mind the workflow's concurrency settings. Good for sprint-opening bookkeeping. ${FILTERS_NOTE}`,
    }),
    trigger("JIRA_ISSUE_CREATED", "Jira", "Ticket created", JIRA_SEED_PATHS, {
      description: "Fires when a Jira ticket is created.",
      details: `Needs the Jira webhook configured in Settings — the polled Jira triggers only observe tickets something already fetched, so they cannot see a brand-new one. Scope the webhook's JQL filter to the projects you care about, since every created ticket otherwise starts a run. ${FILTERS_NOTE}`,
    }),
    trigger("JIRA_ISSUE_DELETED", "Jira", "Ticket deleted", JIRA_SEED_PATHS, {
      description: "Fires when a Jira ticket is deleted.",
      details: `Needs the Jira webhook. The ticket is gone by the time this runs, so only the payload's \`ticket.*\` snapshot is available — a step that loads the ticket will fail. Use it for cleanup: close the worktree, cancel the run, archive the branch. ${FILTERS_NOTE}`,
    }),
    trigger(
      "JIRA_ISSUE_COMMAND",
      "Jira",
      "Ticket comment command",
      JIRA_SEED_PATHS,
      {
        description:
          "Fires when a comment from an allow-listed Jira account matches a command pattern, such as `/deploy`.",
        details: `The Jira counterpart to the GitHub issue comment command, and just as strict: an explicit list of Jira account IDs is required, and the pattern must be anchored with \`^\` and \`$\` — publishing fails otherwise. Jira identifies people by opaque account ID, not display name, so copy the ID from the user's Jira profile URL. Treat the comment body as untrusted input rather than instructions. Needs the Jira webhook. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "JIRA_ATTACHMENT_ADDED",
      "Jira",
      "Attachment added",
      [...JIRA_SEED_PATHS, "attachment.*"],
      {
        description: "Fires when a file is attached to a Jira ticket.",
        details: `Needs the Jira webhook. Seeds \`attachment.*\` with the filename, MIME type, and author. Filter on \`attachment.mimeType\` to react to one kind of upload — a crash log, a design export. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "JIRA_ISSUE_LINKED",
      "Jira",
      "Ticket linked",
      [...JIRA_SEED_PATHS, "link.*"],
      {
        description: "Fires when a Jira issue link is created.",
        details: `Needs the Jira webhook. Seeds \`link.*\` with the link type and both issue IDs. Filter on \`link.type\` to react to one relationship — "blocks", "duplicates" — rather than every link. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_STARTED",
      "Plans and sessions",
      "Run started",
      RUN_SEED_PATHS,
      {
        description: "Fires when an AI plan or session run begins.",
        details: `Every run trigger seeds the same shape — \`run.*\` plus the worktree, codebase, repository, and ticket it is attached to. Filter on \`run.kind\` to separate plans from sessions. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_COMPLETED",
      "Plans and sessions",
      "Run completed",
      RUN_SEED_PATHS,
      {
        description: "Fires when an AI run finishes successfully.",
        details: `The place to hang everything that happens after the agent is done — committing, pushing, opening a pull request, moving the ticket. Filter on \`run.kind\` to react only to plans or only to sessions. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_QUESTION_NEEDED",
      "Plans and sessions",
      "Run needs an answer",
      RUN_SEED_PATHS,
      {
        description:
          "Fires when an AI run pauses to ask a question, with the pending questions in session data.",
        details: `The questions arrive under \`run.questions\`, so the Answer run question step can respond without a human — the basis for unattended runs. Answer carefully: an automatic answer to a question the agent should have asked a person is how unwanted changes get made. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_QUESTION_ANSWERED",
      "Plans and sessions",
      "Run question answered",
      RUN_SEED_PATHS,
      {
        description: "Fires when a pending question on an AI run is answered.",
        details: `Fires however the answer arrived — from a person or from another workflow. Use it to record decisions, or to resume work that was gated on the answer. ${FILTERS_NOTE}`,
      },
    ),
    trigger("RUN_PAUSED", "Plans and sessions", "Run paused", RUN_SEED_PATHS, {
      description: "Fires when an AI run is paused.",
      details: `Covers pauses from any source, including a run that paused itself. A run needing an answer reports separately through Run needs an answer. ${FILTERS_NOTE}`,
    }),
    trigger(
      "RUN_CONTINUED",
      "Plans and sessions",
      "Run continued",
      RUN_SEED_PATHS,
      {
        description: "Fires when a paused AI run resumes.",
        details: `The counterpart to Run paused. Fires on each resume, so a run that stops and starts repeatedly fires it repeatedly. ${FILTERS_NOTE}`,
      },
    ),
    trigger("RUN_FAILED", "Plans and sessions", "Run failed", RUN_SEED_PATHS, {
      description: "Fires when an AI run ends in failure.",
      details: `The error is in the seeded run data, so a follow-up run can be pointed at what went wrong. Beware of loops — a workflow that reacts by starting another run that fails the same way will keep going. ${FILTERS_NOTE}`,
    }),
    trigger(
      "RUN_CANCELLED",
      "Plans and sessions",
      "Run cancelled",
      RUN_SEED_PATHS,
      {
        description: "Fires when an AI run is cancelled.",
        details: `Cancellation leaves whatever the run already wrote in the worktree, so cleanup usually means inspecting or reverting rather than assuming nothing happened. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_PLAN_PLAYED",
      "Plans and sessions",
      "Plan played",
      RUN_SEED_PATHS,
      {
        description:
          "Fires when a run is created by executing a previously completed plan.",
        details: `Distinguishes plan execution from an ordinary session, which Run started cannot. Lets a workflow treat planned work differently from ad-hoc work. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_FOLLOW_UP",
      "Plans and sessions",
      "Run follow-up created",
      RUN_SEED_PATHS,
      {
        description:
          "Fires when a run is created as a follow-up to another run.",
        details: `Does not fire for plan execution, which reports through Plan played. The parent run is in the seeded data, so a workflow can count how deep a follow-up chain has gone and stop it. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_IMPORTED",
      "Plans and sessions",
      "Provider run imported",
      RUN_SEED_PATHS,
      {
        description:
          "Fires when a run started outside this system is imported from a provider.",
        details: `Lets work begun in another tool pick up the same automation — labelling, ticket updates, pull requests. The run did not originate here, so its worktree and ticket links may be incomplete. ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_USAGE_THRESHOLD",
      "Plans and sessions",
      "Run usage threshold",
      RUN_SEED_PATHS,
      {
        description:
          "Fires when a single run's token or cost usage crosses a threshold you set.",
        details: `Scoped to one run, unlike the aggregate Usage threshold. Point the threshold path at the usage figure you care about — a runaway session can then be cancelled automatically. ${THRESHOLD_NOTE} ${FILTERS_NOTE}`,
      },
    ),
    trigger(
      "RUN_EVENT_MATCH",
      "Plans and sessions",
      "Run event or tool matched",
      RUN_SEED_PATHS,
      {
        description:
          "Fires on individual events inside an AI run, including each tool call it makes.",
        details: `The finest-grained run trigger, and by far the most talkative — a single run produces hundreds of events, and every one is a candidate. Always filter, on the event type or the tool name. Useful for reacting to a specific tool being used; a poor choice for anything expensive. ${FILTERS_NOTE}`,
      },
    ),
    ...EXPANSION_TRIGGER_CATALOG,
  ];

export const WORKFLOW_TRIGGER_BY_KIND = new Map(
  WORKFLOW_TRIGGER_CATALOG.map((entry) => [entry.kind, entry]),
);

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const sessionPath = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_*\[\]-]+)*$/);
const objectConfig = z.record(z.string(), z.unknown()).default({});

export const workflowTriggerSchema = z.object({
  id: identifier,
  kind: z.enum(WORKFLOW_TRIGGER_KINDS),
  name: z.string().min(1).max(200).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: objectConfig,
});

export const workflowNodeSchema = z.object({
  id: identifier,
  kind: z.enum(WORKFLOW_STEP_KINDS),
  name: z.string().min(1).max(200).optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: objectConfig,
  requiredPaths: z.array(sessionPath).max(100).default([]),
  providedPaths: z.array(sessionPath).max(100).default([]),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(20).default(1),
      strategy: z.enum(["FIXED", "EXPONENTIAL"]).default("EXPONENTIAL"),
      delaySeconds: z.number().int().min(1).max(86_400).default(5),
    })
    .default({ maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 }),
  failurePolicy: z.enum(["FAIL", "CONTINUE"]).default("FAIL"),
});

export const workflowEdgeSchema = z.object({
  id: identifier,
  source: identifier,
  target: identifier,
  sourceHandle: z.string().min(1).max(100).default("success"),
  targetHandle: z.string().min(1).max(100).default("input"),
});

export const workflowDefinitionSchema = z.object({
  format: z.literal(WORKFLOW_FORMAT),
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).default(""),
  triggers: z.array(workflowTriggerSchema).max(100).default([]),
  nodes: z.array(workflowNodeSchema).max(1_000).default([]),
  edges: z.array(workflowEdgeSchema).max(5_000).default([]),
  editor: z
    .object({
      viewport: z
        .object({ x: z.number(), y: z.number(), zoom: z.number().positive() })
        .optional(),
      // Which edges of a step card its connectors sit on. Presentation only —
      // handle ids are unchanged, so existing edges survive a switch — but it
      // travels with the definition so a published run draws the way its
      // author laid it out.
      handleLayout: z.enum(["SIDES", "TOP_BOTTOM"]).default("SIDES"),
      // Read-only graphs can either honor the authored coordinates or derive a
      // compact responsive layout. The editor always keeps authored positions
      // intact, so switching this never loses a user's canvas work.
      displayLayout: z.enum(["REGULAR", "BASIC"]).default("REGULAR"),
    })
    .default({ handleLayout: "SIDES", displayLayout: "REGULAR" }),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowNodeDefinition = z.infer<typeof workflowNodeSchema>;
export type WorkflowTriggerDefinition = z.infer<typeof workflowTriggerSchema>;

export type WorkflowDiagnostic = {
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  nodeId?: string;
  triggerId?: string;
  path?: string;
};

export function emptyWorkflowDefinition(
  name = "Untitled workflow",
): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    format: WORKFLOW_FORMAT,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    name,
    description: "",
    triggers: [
      { id: "manual", kind: "MANUAL", position: { x: 0, y: 100 }, config: {} },
    ],
    nodes: [],
    edges: [],
    editor: {},
  });
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(value);
}

export function sanitizeWorkflowExportDefinition(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  const sanitize = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([childKey, entry]) => [childKey, sanitize(entry, childKey)],
        ),
      );
    }
    if (
      typeof value === "string" &&
      /(token|secret|password|passwd|private.?key|api.?key|authorization)/i.test(
        key,
      ) &&
      !/(credential.?id|credential.?ids)$/i.test(key)
    ) {
      return null;
    }
    if (
      typeof value === "string" &&
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value) &&
      /^(?:cwd|folder|path|directory)$/i.test(key)
    ) {
      return null;
    }
    return value;
  };
  return workflowDefinitionSchema.parse(sanitize(definition));
}

function expandedPaths(
  node: { id: string },
  paths: readonly string[],
): string[] {
  return paths.map((path) => path.replaceAll("<stepId>", node.id));
}

function pathCovers(provided: string, required: string): boolean {
  if (provided === required || provided === "*") return true;
  return provided.endsWith(".*") && required.startsWith(provided.slice(0, -1));
}

function pathsOverlap(first: string, second: string): boolean {
  return pathCovers(first, second) || pathCovers(second, first);
}

function intersection(sets: Set<string>[]): Set<string> {
  if (!sets.length) return new Set();
  return new Set(
    [...sets[0]!].filter((value) => sets.every((set) => set.has(value))),
  );
}

function hasPath(available: Set<string>, required: string): boolean {
  return [...available].some((provided) => pathCovers(provided, required));
}

/**
 * Supplies the required/provided/seed paths for a kind. The default reads the
 * in-memory catalog (server); the editor passes a lookup backed by the catalog
 * it fetches over GraphQL so the same reachability walk runs client-side.
 */
export type WorkflowPathLookup = {
  stepPaths(kind: string): { requiredPaths: string[]; providedPaths: string[] };
  triggerSeedPaths(kind: string): string[];
};

const defaultPathLookup: WorkflowPathLookup = {
  stepPaths(kind) {
    const entry = WORKFLOW_STEP_BY_KIND.get(kind as WorkflowStepKind);
    return {
      requiredPaths: entry?.requiredPaths ?? [],
      providedPaths: entry?.providedPaths ?? [],
    };
  },
  triggerSeedPaths(kind) {
    return (
      WORKFLOW_TRIGGER_BY_KIND.get(kind as WorkflowTriggerKind)?.seedPaths ?? []
    );
  },
};

export type WorkflowRequirementViolation = {
  nodeId: string;
  triggerId: string;
  triggerName: string;
  path: string;
};

/**
 * Structural shape of a definition the availability walk needs. Deliberately
 * loose so both the zod-inferred `WorkflowDefinition` (server) and the client
 * editor's hand-written definition type satisfy it.
 */
export type WorkflowAvailabilityInput = {
  triggers: readonly {
    id: string;
    kind: string;
    name?: string;
    config?: unknown;
  }[];
  nodes: readonly {
    id: string;
    kind: string;
    config: unknown;
    requiredPaths: readonly string[];
    providedPaths: readonly string[];
  }[];
  edges: readonly { source: string; target: string }[];
};

/**
 * Walks the workflow DAG from every trigger and computes, per step node, the
 * session paths guaranteed to exist *before* it runs (`availableBefore`, the
 * cross-trigger intersection — exactly what a step may bind its config to) and
 * the paths it contributes (`provides`). Also surfaces requirement violations
 * so `validateWorkflowDefinition` can raise `REQUIREMENT_UNSATISFIED`.
 */
export function computeWorkflowPathAvailability(
  definition: WorkflowAvailabilityInput,
  lookup: WorkflowPathLookup = defaultPathLookup,
): {
  availableBefore: Map<string, string[]>;
  provides: Map<string, string[]>;
  requirementViolations: WorkflowRequirementViolation[];
} {
  const nodeIds = new Set(definition.nodes.map(({ id }) => id));
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
    incoming.set(edge.target, [
      ...(incoming.get(edge.target) ?? []),
      edge.source,
    ]);
  }

  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target))
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const topological: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topological.push(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!nodeIds.has(target)) continue;
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }

  const walk = (start: string): Set<string> => {
    const visited = new Set<string>();
    const pending = [...(outgoing.get(start) ?? [])];
    while (pending.length) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(outgoing.get(id) ?? []));
    }
    return visited;
  };
  const reachability = new Map<string, Set<string>>();
  for (const item of [...definition.triggers, ...definition.nodes])
    reachability.set(item.id, walk(item.id));

  const provides = new Map<string, string[]>();
  for (const node of definition.nodes) {
    const catalog = lookup.stepPaths(node.kind);
    provides.set(node.id, [
      ...expandedPaths(node, catalog.providedPaths),
      ...node.providedPaths,
      `steps.${node.id}.*`,
    ]);
  }

  const availableBefore = new Map<string, Set<string>>();
  const requirementViolations: WorkflowRequirementViolation[] = [];
  for (const triggerDefinition of definition.triggers) {
    // Every run carries the workflow identity; a trigger adds its own seeds,
    // and a RESOURCE_MANUAL trigger adds the paths of its configured resource.
    const seed = new Set<string>(["workflow.*"]);
    for (const path of lookup.triggerSeedPaths(triggerDefinition.kind))
      seed.add(path);
    for (const path of resourceManualSeedPaths(
      triggerDefinition.kind,
      triggerDefinition.config,
    ))
      seed.add(path);
    const availableAfter = new Map<string, Set<string>>();
    for (const nodeId of topological) {
      if (!reachability.get(triggerDefinition.id)?.has(nodeId)) continue;
      const node = nodeById.get(nodeId)!;
      const sources = (incoming.get(nodeId) ?? []).filter(
        (source) =>
          source === triggerDefinition.id || availableAfter.has(source),
      );
      if (!sources.length) continue;
      const available = intersection(
        sources.map((source) =>
          source === triggerDefinition.id ? seed : availableAfter.get(source)!,
        ),
      );
      const existing = availableBefore.get(nodeId);
      availableBefore.set(
        nodeId,
        existing ? intersection([existing, available]) : new Set(available),
      );
      // Config session bindings become hard requirements only where the
      // descriptor marks the key required (`requiredConfigSessionPaths`), and
      // even then not when the step *provides* the namespace it reads: a loader
      // like JIRA_LOAD_TICKET binds `issueKey` to `{{ticket.key}}` to establish
      // `ticket.*`. Such self-referential bindings are the "unwrap" point — the
      // step resolves the optional value at run time and fails if it is absent
      // (see `jiraKey` in register-adapters) — so they must not block publish.
      // Explicit `requiredPaths` (catalog + node) stay strict.
      const selfProvided = new Set(provides.get(nodeId) ?? []);
      const configRequired = [
        ...requiredConfigSessionPaths(node.kind, "step", node.config),
      ].filter((path) => !hasPath(selfProvided, path));
      const required = new Set([
        ...expandedPaths(node, lookup.stepPaths(node.kind).requiredPaths),
        ...node.requiredPaths,
        ...configRequired,
      ]);
      for (const path of required) {
        if (!hasPath(available, path))
          requirementViolations.push({
            nodeId: node.id,
            triggerId: triggerDefinition.id,
            triggerName: triggerDefinition.name ?? triggerDefinition.kind,
            path,
          });
      }
      const after = new Set(available);
      for (const path of provides.get(nodeId) ?? []) after.add(path);
      availableAfter.set(nodeId, after);
    }
  }

  return {
    availableBefore: new Map(
      [...availableBefore].map(([id, set]) => [id, [...set]]),
    ),
    provides,
    requirementViolations,
  };
}

function hasSensitiveLiteral(value: unknown, key = ""): boolean {
  if (Array.isArray(value))
    return value.some((entry) => hasSensitiveLiteral(entry, key));
  if (!value || typeof value !== "object") {
    return (
      typeof value === "string" &&
      /(token|secret|password|passwd|private.?key|api.?key|authorization)/i.test(
        key,
      ) &&
      !/(credential.?id|credential.?ids)$/i.test(key)
    );
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([childKey, entry]) => hasSensitiveLiteral(entry, childKey),
  );
}

function hasUnresolvedReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnresolvedReference);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.referenceStatus === "UNRESOLVED" ||
    Object.values(record).some(hasUnresolvedReference)
  );
}

export function validateWorkflowDefinition(value: unknown): {
  definition: WorkflowDefinition | null;
  diagnostics: WorkflowDiagnostic[];
} {
  const parsed = workflowDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    return {
      definition: null,
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: "ERROR",
        code: "SCHEMA_INVALID",
        message: issue.message,
        path: issue.path.join("."),
      })),
    };
  }
  const definition = parsed.data;
  const diagnostics: WorkflowDiagnostic[] = [];
  const allIds = new Set<string>();
  for (const item of [...definition.triggers, ...definition.nodes]) {
    if (allIds.has(item.id)) {
      diagnostics.push({
        severity: "ERROR",
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate graph id ${item.id}`,
        nodeId: item.id,
      });
    }
    allIds.add(item.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id))
      diagnostics.push({
        severity: "ERROR",
        code: "DUPLICATE_EDGE_ID",
        message: `Duplicate edge id ${edge.id}`,
      });
    edgeIds.add(edge.id);
    if (!allIds.has(edge.source) || !allIds.has(edge.target)) {
      diagnostics.push({
        severity: "ERROR",
        code: "EDGE_ENDPOINT_MISSING",
        message: `Edge ${edge.id} references a missing endpoint`,
      });
    }
    if (definition.triggers.some(({ id }) => id === edge.target)) {
      diagnostics.push({
        severity: "ERROR",
        code: "TRIGGER_HAS_INPUT",
        message: "Triggers cannot have incoming edges",
        triggerId: edge.target,
      });
    }
  }
  if (!definition.triggers.length)
    diagnostics.push({
      severity: "ERROR",
      code: "TRIGGER_REQUIRED",
      message: "At least one trigger is required",
    });
  if (!definition.nodes.length)
    diagnostics.push({
      severity: "ERROR",
      code: "STEP_REQUIRED",
      message: "At least one step is required",
    });

  const nodeIds = new Set(definition.nodes.map(({ id }) => id));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
    incoming.set(edge.target, [
      ...(incoming.get(edge.target) ?? []),
      edge.source,
    ]);
  }
  for (const node of definition.nodes) {
    const parents = (incoming.get(node.id) ?? []).filter((id) =>
      nodeIds.has(id),
    );
    if (parents.length > 1 && node.kind !== "CONTROL_JOIN") {
      diagnostics.push({
        severity: "ERROR",
        code: "EXPLICIT_JOIN_REQUIRED",
        message:
          "Nodes with multiple incoming branches must be explicit join nodes",
        nodeId: node.id,
      });
    }
  }

  const indegree = new Map(definition.nodes.map((node) => [node.id, 0]));
  for (const edge of definition.edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target))
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  const topological: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topological.push(id);
    for (const target of outgoing.get(id) ?? []) {
      if (!nodeIds.has(target)) continue;
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(target);
    }
  }
  if (topological.length !== definition.nodes.length)
    diagnostics.push({
      severity: "ERROR",
      code: "DAG_CYCLE",
      message: "Workflow graphs cannot contain free-form cycles",
    });

  const reachability = new Map<string, Set<string>>();
  const walk = (start: string): Set<string> => {
    const visited = new Set<string>();
    const pending = [...(outgoing.get(start) ?? [])];
    while (pending.length) {
      const id = pending.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(outgoing.get(id) ?? []));
    }
    return visited;
  };
  for (const item of [...definition.triggers, ...definition.nodes])
    reachability.set(item.id, walk(item.id));
  for (const node of definition.nodes) {
    if (
      !definition.triggers.some((entry) =>
        reachability.get(entry.id)?.has(node.id),
      )
    ) {
      diagnostics.push({
        severity: "ERROR",
        code: "UNREACHABLE_STEP",
        message: "Step is not reachable from a trigger",
        nodeId: node.id,
      });
    }
    if (hasSensitiveLiteral(node.config))
      diagnostics.push({
        severity: "ERROR",
        code: "SECRET_LITERAL",
        message:
          "Store secrets as credential references, not workflow literals",
        nodeId: node.id,
      });
    if (hasUnresolvedReference(node.config))
      diagnostics.push({
        severity: "ERROR",
        code: "UNRESOLVED_REFERENCE",
        message: "Resolve imported references before publishing",
        nodeId: node.id,
      });
    for (const message of new Set(invalidWorkflowValueBindings(node.config)))
      diagnostics.push({
        severity: "ERROR",
        code: "SESSION_BINDING_INVALID",
        message,
        nodeId: node.id,
      });
    if (
      node.kind === "CONTROL_SUBWORKFLOW" &&
      typeof node.config.versionId !== "string"
    )
      diagnostics.push({
        severity: "ERROR",
        code: "SUBWORKFLOW_VERSION_REQUIRED",
        message: "Sub-workflows must pin a published version",
        nodeId: node.id,
      });

    if (node.kind === "SAVED_COMMAND" || node.kind === "CUSTOM_COMMAND") {
      const pattern = commandOutputPattern(node.config);
      const usesMatchHandle = definition.edges.some(
        (edge) => edge.source === node.id && edge.sourceHandle === "match",
      );
      if (usesMatchHandle && !pattern) {
        diagnostics.push({
          severity: "ERROR",
          code: "COMMAND_MATCH_PATTERN_REQUIRED",
          message: "The match connector requires an output pattern",
          nodeId: node.id,
        });
      }
      if (pattern) {
        if (
          node.config.outputMatchMode !== undefined &&
          node.config.outputMatchMode !== "ONCE" &&
          node.config.outputMatchMode !== "EACH_MATCH"
        ) {
          diagnostics.push({
            severity: "ERROR",
            code: "COMMAND_MATCH_MODE_INVALID",
            message: "Output match behavior must be Once or Each match",
            nodeId: node.id,
          });
        }
        if (node.config.completionMode === "FIRE_AND_FORGET") {
          diagnostics.push({
            severity: "ERROR",
            code: "COMMAND_MATCH_REQUIRES_WAIT",
            message: "Output matching requires Wait for exit completion",
            nodeId: node.id,
          });
        }
        try {
          validateCommandOutputPattern(pattern);
        } catch (error) {
          diagnostics.push({
            severity: "ERROR",
            code: "COMMAND_MATCH_PATTERN_INVALID",
            message: error instanceof Error ? error.message : String(error),
            nodeId: node.id,
          });
        }

        const starts = (handle: string) =>
          definition.edges
            .filter(
              (edge) => edge.source === node.id && edge.sourceHandle === handle,
            )
            .map(({ target }) => target);
        const descendants = (roots: string[]) => {
          const visited = new Set<string>();
          const pending = [...roots];
          while (pending.length) {
            const id = pending.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            pending.push(
              ...definition.edges
                .filter((edge) => edge.source === id)
                .map(({ target }) => target),
            );
          }
          return visited;
        };
        const matchBranch = descendants(starts("match"));
        const terminalBranch = descendants([
          ...starts("success"),
          ...starts("failure"),
        ]);
        if ([...matchBranch].some((id) => terminalBranch.has(id))) {
          diagnostics.push({
            severity: "ERROR",
            code: "COMMAND_MATCH_BRANCH_RECONVERGES",
            message:
              "A command match branch cannot reconverge with its success or failure branch",
            nodeId: node.id,
          });
        }
      }
    }
  }
  for (const triggerDefinition of definition.triggers) {
    if (!(outgoing.get(triggerDefinition.id) ?? []).length)
      diagnostics.push({
        severity: "ERROR",
        code: "TRIGGER_DISCONNECTED",
        message: "Trigger is not connected to a step",
        triggerId: triggerDefinition.id,
      });
    if (hasSensitiveLiteral(triggerDefinition.config))
      diagnostics.push({
        severity: "ERROR",
        code: "SECRET_LITERAL",
        message: "Store secrets as credential references, not trigger literals",
        triggerId: triggerDefinition.id,
      });
    if (hasUnresolvedReference(triggerDefinition.config))
      diagnostics.push({
        severity: "ERROR",
        code: "UNRESOLVED_REFERENCE",
        message: "Resolve imported references before publishing",
        triggerId: triggerDefinition.id,
      });
    for (const message of new Set(
      invalidWorkflowValueBindings(triggerDefinition.config),
    ))
      diagnostics.push({
        severity: "ERROR",
        code: "SESSION_BINDING_INVALID",
        message,
        triggerId: triggerDefinition.id,
      });
    if (
      isResourceTriggerKind(triggerDefinition.kind) &&
      !workflowResourceKind(triggerDefinition.config)
    )
      diagnostics.push({
        severity: "ERROR",
        code: "RESOURCE_KIND_REQUIRED",
        message:
          "Resource triggers must target a single resource kind; add one trigger per kind",
        triggerId: triggerDefinition.id,
      });
    if (isChoiceTriggerKind(triggerDefinition.kind)) {
      const choices = workflowTriggerChoices(triggerDefinition.config);
      const declared = Array.isArray(triggerDefinition.config.choices)
        ? triggerDefinition.config.choices.length
        : 0;
      // A key that fails `isWorkflowChoiceKey`, or repeats an earlier one, is
      // dropped by `workflowTriggerChoices` — so a shortfall here is the signal
      // that an option exists in config but can never be picked or routed.
      if (!choices.length || choices.length !== declared)
        diagnostics.push({
          severity: "ERROR",
          code: "TRIGGER_CHOICES_REQUIRED",
          message:
            "Choice triggers need at least one option, each with a unique key",
          triggerId: triggerDefinition.id,
        });
      const keys = new Set(choices.map(({ key }) => key));
      for (const edge of definition.edges) {
        if (edge.source !== triggerDefinition.id) continue;
        if (keys.has(edge.sourceHandle)) continue;
        diagnostics.push({
          severity: "ERROR",
          code: "TRIGGER_CHOICE_HANDLE_UNKNOWN",
          message: `Connection ${edge.id} leaves an option that no longer exists`,
          triggerId: triggerDefinition.id,
        });
      }
    }
    if (
      triggerDefinition.kind === "GITHUB_ISSUE_COMMAND" ||
      triggerDefinition.kind === "JIRA_ISSUE_COMMAND"
    ) {
      const jira = triggerDefinition.kind === "JIRA_ISSUE_COMMAND";
      const allowed = jira
        ? triggerDefinition.config.allowedAccountIds
        : triggerDefinition.config.allowedLogins;
      const pattern = triggerDefinition.config.commandPattern;
      if (
        !Array.isArray(allowed) ||
        !allowed.length ||
        allowed.some((entry) => typeof entry !== "string" || !entry.trim())
      )
        diagnostics.push({
          severity: "ERROR",
          code: "ISSUE_COMMAND_ALLOWLIST_REQUIRED",
          message: jira
            ? "Issue command triggers require an explicit Jira account ID allow-list"
            : "Issue command triggers require an explicit GitHub login allow-list",
          triggerId: triggerDefinition.id,
        });
      if (
        typeof pattern !== "string" ||
        !pattern.startsWith("^") ||
        !pattern.endsWith("$")
      )
        diagnostics.push({
          severity: "ERROR",
          code: "ISSUE_COMMAND_PATTERN_ANCHORED",
          message: "Issue command patterns must be anchored with ^ and $",
          triggerId: triggerDefinition.id,
        });
    }
  }

  for (const violation of computeWorkflowPathAvailability(definition)
    .requirementViolations) {
    diagnostics.push({
      severity: "ERROR",
      code: "REQUIREMENT_UNSATISFIED",
      message: `${violation.path} is not guaranteed on the path from ${violation.triggerName}`,
      nodeId: violation.nodeId,
      triggerId: violation.triggerId,
      path: violation.path,
    });
  }

  for (
    let firstIndex = 0;
    firstIndex < definition.nodes.length;
    firstIndex += 1
  ) {
    const first = definition.nodes[firstIndex]!;
    const firstWrites = [
      ...expandedPaths(
        first,
        WORKFLOW_STEP_BY_KIND.get(first.kind)!.providedPaths,
      ),
      ...first.providedPaths,
    ].filter((path) => !path.startsWith(`steps.${first.id}.`));
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < definition.nodes.length;
      secondIndex += 1
    ) {
      const second = definition.nodes[secondIndex]!;
      if (
        reachability.get(first.id)?.has(second.id) ||
        reachability.get(second.id)?.has(first.id)
      )
        continue;
      const secondWrites = [
        ...expandedPaths(
          second,
          WORKFLOW_STEP_BY_KIND.get(second.kind)!.providedPaths,
        ),
        ...second.providedPaths,
      ].filter((path) => !path.startsWith(`steps.${second.id}.`));
      if (
        firstWrites.some((left) =>
          secondWrites.some((right) => pathsOverlap(left, right)),
        )
      )
        diagnostics.push({
          severity: "ERROR",
          code: "PARALLEL_WRITE_CONFLICT",
          message: `Parallel steps ${first.name ?? first.id} and ${second.name ?? second.id} can write the same session-data path`,
          nodeId: second.id,
        });
    }
  }
  return { definition, diagnostics };
}

export function hasWorkflowErrors(
  diagnostics: readonly WorkflowDiagnostic[],
): boolean {
  return diagnostics.some(({ severity }) => severity === "ERROR");
}
