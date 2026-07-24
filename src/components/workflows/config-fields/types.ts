import type {
  WorkflowStepKind,
  WorkflowTriggerKind,
} from "@/lib/workflows/definition";

/**
 * The interactive control used to edit a single config field. Every kind's
 * config keys are described declaratively here; anything not described falls
 * back to the raw-JSON escape hatch so no config is ever uneditable.
 */
export type ConfigControlType =
  | "enum" // fixed <Select> from static options
  | "text" // <Input> / <Textarea>
  | "number" // numeric <Input>
  | "boolean" // <Checkbox>
  | "resource" // data-driven SearchableSelect (codebaseId, worktreeId, …)
  | "resourceMulti" // multi-select resource list (scriptIds, registrationIds)
  | "stringList" // labels[], destinations[] — add/remove rows
  | "record" // Record<string,string> — fields, answers
  | "model" // combined provider/model/effort picker (catalog or session data)
  | "json"; // per-field JSON fallback for a complex blob

/**
 * A data-driven resource that can be listed through the control plane and
 * rendered as dropdown options. Each maps to a query in use-resource-options.
 */
export type ResourceKind =
  | "codebase"
  | "worktree"
  | "githubRepository"
  | "githubPullRequest"
  | "jiraTicket"
  | "jiraUser"
  | "apnsChannel"
  | "apnsRegistration"
  | "skillGroup"
  | "mcpServer"
  | "iosConfiguration"
  | "buildScript"
  | "agentRun"
  | "githubWorkflowRun";

export type ConfigStaticOption = {
  value: string;
  /** Human label shown in the dropdown. Falls back to the raw value. */
  label?: string;
};

export type ConfigOptionSource =
  | { kind: "static"; options: readonly ConfigStaticOption[] }
  | {
      kind: "resource";
      resource: ResourceKind;
      /**
       * Sibling config key that provides a required scoping argument for the
       * resource query (e.g. `configurationId` needs `codebaseId`). When the
       * sibling value is unset or not a literal string, the control degrades to
       * a free-text input.
       */
      scopeFrom?: string;
    };

/** How a field's value may be authored. Enums/booleans omit this → literal-only. */
export type ConfigValueMode = "literal" | "session" | "interpolation";

export type ConfigFieldDescriptor = {
  key: string;
  label: string;
  control: ConfigControlType;
  options?: ConfigOptionSource;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  help?: string;
  /** Render multi-line text for the `text` control. */
  multiline?: boolean;
  /** Value authoring modes. Undefined → literal only. */
  valueModes?: readonly ConfigValueMode[];
  /**
   * For the `model` control: the sibling config keys the combined picker reads
   * and writes. The control spans all three, and the editor treats each as a
   * described key (so none leaks into the raw-JSON escape hatch). The
   * `scopeFrom` key, when a literal, scopes the provider catalog to a worktree.
   */
  modelKeys?: {
    provider: string;
    model: string;
    effort: string;
    scopeFrom?: string;
  };
};

export type KindConfigDescriptor = {
  fields: ConfigFieldDescriptor[];
};

export type StepConfigDescriptors = Partial<
  Record<WorkflowStepKind, KindConfigDescriptor>
>;

export type TriggerConfigDescriptors = Partial<
  Record<WorkflowTriggerKind, KindConfigDescriptor>
>;

export type ConfigFieldScope = "step" | "trigger";
