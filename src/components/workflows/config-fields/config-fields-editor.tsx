"use client";

import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { SearchableSelect } from "@/components/common/searchable-select";
import { ModelEffortPicker } from "@/components/runs/model-effort-picker";
import { useProviderCatalog } from "@/components/runs/use-provider-catalog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SessionFieldInfo } from "@/lib/workflows/session-schema";

import {
  parseChoiceOptions,
  parseTriggerChoices,
  serializeChoiceOptions,
  serializeTriggerChoices,
  triggerChoiceKeyFromLabel,
  type ChoiceOptionRow,
  type TriggerChoiceRow,
} from "./choice-options";
import {
  CONDITION_OPERATORS,
  conditionOperatorTakesValue,
  conditionValueText,
  parseConditionDraft,
  parseConditionValue,
  serializeConditionDraft,
  type ConditionDraft,
  type ConditionOperatorKey,
  type ConditionRow,
} from "./condition";
import type {
  ConfigFieldDescriptor,
  ConfigFieldScope,
} from "@/lib/workflows/config-descriptor-types";
import { getConfigDescriptor } from "@/lib/workflows/config-descriptors";
import { useResourceOptions } from "./use-resource-options";
import {
  InterpolationHint,
  ValueModeToggle,
  ValueModeField,
  isSessionBinding,
  literalValue,
} from "./value-mode-field";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function literalScope(
  config: Record<string, unknown>,
  key: string | undefined,
): string | null {
  if (!key) return null;
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sessionModes(field: ConfigFieldDescriptor): boolean {
  return Boolean(field.valueModes?.includes("session"));
}

function interpolationModes(field: ConfigFieldDescriptor): boolean {
  return Boolean(field.valueModes?.includes("interpolation"));
}

type FieldProps = {
  field: ConfigFieldDescriptor;
  config: Record<string, unknown>;
  value: unknown;
  onChange: (next: unknown) => void;
  sessionPaths: readonly SessionFieldInfo[];
};

function EnumField({ field, value, onChange }: FieldProps) {
  const t = useTranslations("workflows");
  const id = useId();
  const options = field.options?.kind === "static" ? field.options.options : [];
  return (
    <Field>
      <FieldLabel className="text-xs" htmlFor={id}>
        {field.label}
      </FieldLabel>
      <Select
        onValueChange={(next) => onChange(next)}
        value={asString(literalValue(value))}
      >
        <SelectTrigger className="w-full" id={id}>
          <SelectValue placeholder={t("selectPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label ?? option.value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {field.help && (
        <FieldDescription className="text-[10px]">
          {field.help}
        </FieldDescription>
      )}
    </Field>
  );
}

function TextField({ field, value, onChange, sessionPaths }: FieldProps) {
  return (
    <ValueModeField
      help={field.help}
      interpolationEnabled={interpolationModes(field)}
      label={field.label}
      onChange={onChange}
      sessionEnabled={sessionModes(field)}
      sessionPaths={sessionPaths}
      value={value}
    >
      {(current, onLiteral, controlId) =>
        field.multiline ? (
          <Textarea
            className="min-h-20 text-sm"
            id={controlId}
            onChange={(event) => onLiteral(event.target.value)}
            placeholder={field.placeholder}
            value={asString(current)}
          />
        ) : (
          <Input
            id={controlId}
            onChange={(event) => onLiteral(event.target.value)}
            placeholder={field.placeholder}
            value={asString(current)}
          />
        )
      }
    </ValueModeField>
  );
}

function NumberField({ field, value, onChange, sessionPaths }: FieldProps) {
  return (
    <ValueModeField
      help={field.help}
      label={field.label}
      onChange={onChange}
      sessionEnabled={sessionModes(field)}
      sessionPaths={sessionPaths}
      value={value}
    >
      {(current, onLiteral, controlId) => (
        <Input
          id={controlId}
          onChange={(event) =>
            onLiteral(
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            )
          }
          placeholder={field.placeholder}
          type="number"
          value={
            typeof current === "number" && Number.isFinite(current)
              ? String(current)
              : ""
          }
        />
      )}
    </ValueModeField>
  );
}

function BooleanField({ field, value, onChange }: FieldProps) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Checkbox
        checked={literalValue(value) === true}
        id={id}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
      <FieldContent>
        <FieldLabel className="text-xs" htmlFor={id}>
          {field.label}
        </FieldLabel>
        {field.help && (
          <FieldDescription className="text-[10px]">
            {field.help}
          </FieldDescription>
        )}
      </FieldContent>
    </Field>
  );
}

function ResourceField({
  field,
  config,
  value,
  onChange,
  sessionPaths,
}: FieldProps) {
  const t = useTranslations("workflows");
  const source = field.options?.kind === "resource" ? field.options : null;
  const scope = literalScope(config, source?.scopeFrom);
  const { options, loading } = useResourceOptions(
    source?.resource ?? "codebase",
    scope,
  );
  const resourceSessionPath = source?.sessionPath;
  const resourceSessionPaths = resourceSessionPath
    ? sessionPaths.filter(({ path }) => {
        const [namespace, sessionField] = resourceSessionPath.split(".");
        return (
          path === resourceSessionPath ||
          (path.startsWith(`${namespace}.`) &&
            path.endsWith(`.${sessionField}`))
        );
      })
    : sessionPaths;
  return (
    <ValueModeField
      allowCustomSessionPath={!resourceSessionPath}
      defaultSessionPath={resourceSessionPath}
      help={field.help}
      interpolationEnabled={interpolationModes(field)}
      label={field.label}
      onChange={onChange}
      sessionEnabled={sessionModes(field)}
      sessionPaths={resourceSessionPaths}
      value={value}
    >
      {(current, onLiteral) => (
        <SearchableSelect
          allowCustomValue
          ariaLabel={field.label}
          disabled={loading}
          emptyMessage={t("noOptions")}
          onValueChange={onLiteral}
          options={options}
          placeholder={field.placeholder ?? t("selectPlaceholder")}
          searchPlaceholder={t("searchPlaceholder")}
          value={asString(current)}
        />
      )}
    </ValueModeField>
  );
}

function ResourceMultiField({ field, config, value, onChange }: FieldProps) {
  const t = useTranslations("workflows");
  const source = field.options?.kind === "resource" ? field.options : null;
  const scope = literalScope(config, source?.scopeFrom);
  const { options, loading } = useResourceOptions(
    source?.resource ?? "codebase",
    scope,
  );
  const selected = Array.isArray(value) ? value.map(String) : [];
  const remaining = options.filter(
    (option) => !selected.includes(option.value),
  );
  const labelFor = (id: string) =>
    options.find((option) => option.value === id)?.label ?? id;

  const add = (id: string) => {
    if (id && !selected.includes(id)) onChange([...selected, id]);
  };
  const remove = (id: string) => {
    onChange(selected.filter((entry) => entry !== id));
  };

  return (
    <Field>
      <FieldLabel className="text-xs">{field.label}</FieldLabel>
      <ItemGroup className="gap-1.5">
        {selected.map((id) => (
          <Item key={id} size="xs" variant="muted">
            <ItemContent className="min-w-0">
              <ItemTitle className="block truncate text-xs">
                {labelFor(id)}
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={t("removeRow")}
                    className="size-7"
                    onClick={() => remove(id)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("removeRow")}</TooltipContent>
              </Tooltip>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <SearchableSelect
        allowCustomValue
        ariaLabel={field.label}
        disabled={loading}
        emptyMessage={t("noOptions")}
        onValueChange={add}
        options={remaining}
        placeholder={field.placeholder ?? t("addRow")}
        searchPlaceholder={t("searchPlaceholder")}
        value=""
      />
      {field.help && (
        <FieldDescription className="text-[10px]">
          {field.help}
        </FieldDescription>
      )}
      {interpolationModes(field) && <InterpolationHint />}
    </Field>
  );
}

function StringListField({ field, value, onChange }: FieldProps) {
  const t = useTranslations("workflows");
  const items = Array.isArray(value) ? value.map(String) : [];
  const setItem = (index: number, next: string) =>
    onChange(
      items.map((entry, position) => (position === index ? next : entry)),
    );
  const removeItem = (index: number) =>
    onChange(items.filter((_entry, position) => position !== index));

  return (
    <Field>
      <FieldLabel className="text-xs">{field.label}</FieldLabel>
      <FieldGroup className="gap-1.5">
        {items.map((entry, index) => (
          <InputGroup key={index}>
            <InputGroupInput
              onChange={(event) => setItem(index, event.target.value)}
              placeholder={field.placeholder}
              value={entry}
            />
            <InputGroupAddon align="inline-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    aria-label={t("removeRow")}
                    onClick={() => removeItem(index)}
                    size="icon-xs"
                  >
                    <Trash2 className="size-3.5" />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>{t("removeRow")}</TooltipContent>
              </Tooltip>
            </InputGroupAddon>
          </InputGroup>
        ))}
      </FieldGroup>
      <Button
        onClick={() => onChange([...items, ""])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {t("addRow")}
      </Button>
      {field.help && (
        <FieldDescription className="text-[10px]">
          {field.help}
        </FieldDescription>
      )}
      {interpolationModes(field) && <InterpolationHint />}
    </Field>
  );
}

function RecordField({ field, value, onChange }: FieldProps) {
  const t = useTranslations("workflows");
  const entries =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>).map(
          ([key, entry]) => [key, entry] as const,
        )
      : [];

  const commit = (next: (readonly [string, unknown])[]) => {
    const record: Record<string, unknown> = {};
    for (const [key, entry] of next) {
      if (key) record[key] = entry;
    }
    onChange(record);
  };

  return (
    <Field>
      <FieldLabel className="text-xs">{field.label}</FieldLabel>
      <FieldGroup className="gap-1.5">
        {entries.map(([key, entry], index) => (
          <div className="flex items-center gap-2" key={index}>
            <Input
              className="w-2/5"
              onChange={(event) =>
                commit(
                  entries.map((pair, position) =>
                    position === index
                      ? ([event.target.value, pair[1]] as const)
                      : pair,
                  ),
                )
              }
              placeholder={t("recordKeyPlaceholder")}
              value={key}
            />
            <Input
              className="min-w-0 flex-1"
              onChange={(event) =>
                commit(
                  entries.map((pair, position) =>
                    position === index
                      ? ([pair[0], event.target.value] as const)
                      : pair,
                  ),
                )
              }
              placeholder={t("recordValuePlaceholder")}
              value={asString(entry)}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={t("removeRow")}
                  className="size-7 shrink-0"
                  onClick={() =>
                    commit(
                      entries.filter((_pair, position) => position !== index),
                    )
                  }
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("removeRow")}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </FieldGroup>
      <Button
        onClick={() => commit([...entries, ["", ""] as const])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {t("addRow")}
      </Button>
      {field.help && (
        <FieldDescription className="text-[10px]">
          {field.help}
        </FieldDescription>
      )}
      {interpolationModes(field) && <InterpolationHint />}
    </Field>
  );
}

function JsonField({ field, value, onChange }: FieldProps) {
  const id = useId();
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef(text);

  useEffect(() => {
    const serialized =
      value === undefined ? "" : JSON.stringify(value, null, 2);
    if (serialized !== lastEmitted.current) {
      setText(serialized);
      lastEmitted.current = serialized;
      setError(null);
    }
  }, [value]);

  const onText = (next: string) => {
    setText(next);
    if (next.trim() === "") {
      lastEmitted.current = "";
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      lastEmitted.current = JSON.stringify(parsed, null, 2);
      setError(null);
      onChange(parsed);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    }
  };

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel className="text-xs" htmlFor={id}>
        {field.label}
      </FieldLabel>
      <Textarea
        aria-invalid={Boolean(error)}
        className="min-h-24 font-mono text-xs"
        id={id}
        onChange={(event) => onText(event.target.value)}
        placeholder={field.placeholder}
        value={text}
      />
      {error ? (
        <FieldError className="text-[10px]">{error}</FieldError>
      ) : (
        <>
          {field.help && (
            <FieldDescription className="text-[10px]">
              {field.help}
            </FieldDescription>
          )}
          {interpolationModes(field) && <InterpolationHint />}
        </>
      )}
    </Field>
  );
}

/**
 * Row-per-comparison builder for an if / wait-until condition. The stored shape
 * is a nested boolean tree, but the shape people actually write is a flat list
 * of "session value / operator / value" rows joined by all-or-any, so that is
 * what the form edits. Anything richer than that — a nested group, a left side
 * that is not a session binding — falls back to the JSON control rather than
 * being rewritten into something the builder can draw.
 */
function ConditionField(props: FieldProps) {
  const { field, value, onChange, sessionPaths } = props;
  const t = useTranslations("workflows");
  const draft = parseConditionDraft(value);
  const sessionOptions = sessionPaths.map(({ path, description }) => ({
    value: path,
    label: path,
    description,
  }));

  if (!draft) {
    return (
      <div className="space-y-1.5">
        <JsonField {...props} />
        <FieldDescription className="text-[10px]">
          {t("conditionAdvanced")}
        </FieldDescription>
      </div>
    );
  }

  const commit = (next: ConditionDraft) =>
    onChange(serializeConditionDraft(next));
  const patchRow = (index: number, changes: Partial<ConditionRow>) =>
    commit({
      ...draft,
      rows: draft.rows.map((row, position) =>
        position === index ? { ...row, ...changes } : row,
      ),
    });

  return (
    <Field>
      <FieldLabel className="text-xs">{field.label}</FieldLabel>
      {draft.rows.length > 1 && (
        <Select
          onValueChange={(mode) =>
            commit({ ...draft, mode: mode === "ANY" ? "ANY" : "ALL" })
          }
          value={draft.mode}
        >
          <SelectTrigger
            aria-label={t("conditionMatchMode")}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("conditionMatchAll")}</SelectItem>
            <SelectItem value="ANY">{t("conditionMatchAny")}</SelectItem>
          </SelectContent>
        </Select>
      )}
      <FieldGroup className="gap-1.5">
        {draft.rows.map((row, index) => (
          <div className="space-y-1.5 rounded-lg border p-2" key={index}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <SearchableSelect
                  allowCustomValue
                  ariaLabel={t("conditionField")}
                  emptyMessage={t("noOptions")}
                  onValueChange={(path) => patchRow(index, { path })}
                  options={sessionOptions}
                  placeholder={t("sessionPathPlaceholder")}
                  searchPlaceholder={t("searchPlaceholder")}
                  value={row.path}
                />
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={t("removeRow")}
                    className="size-7 shrink-0"
                    onClick={() =>
                      commit({
                        ...draft,
                        rows: draft.rows.filter(
                          (_entry, position) => position !== index,
                        ),
                      })
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("removeRow")}</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              <Select
                onValueChange={(operator) =>
                  patchRow(index, {
                    operator: operator as ConditionOperatorKey,
                  })
                }
                value={row.operator}
              >
                <SelectTrigger
                  aria-label={t("conditionOperator")}
                  className="w-40 shrink-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITION_OPERATORS.map((operator) => (
                    <SelectItem key={operator.value} value={operator.value}>
                      {t(`conditionOperators.${operator.value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {conditionOperatorTakesValue(row.operator) && (
                <>
                  {isSessionBinding(row.value) ? (
                    <div className="min-w-0 flex-1">
                      <SearchableSelect
                        allowCustomValue
                        ariaLabel={t("sessionBindingLabel")}
                        emptyMessage={t("noOptions")}
                        onValueChange={(path) =>
                          patchRow(index, {
                            value: { source: "SESSION", path },
                          })
                        }
                        options={sessionOptions}
                        placeholder={t("sessionPathPlaceholder")}
                        searchPlaceholder={t("searchPlaceholder")}
                        value={row.value.path}
                      />
                    </div>
                  ) : (
                    <Input
                      aria-label={t("conditionValue")}
                      className="min-w-0 flex-1"
                      onChange={(event) =>
                        patchRow(index, {
                          value: parseConditionValue(event.target.value),
                        })
                      }
                      placeholder={t("conditionValuePlaceholder")}
                      value={conditionValueText(row.value)}
                    />
                  )}
                  <ValueModeToggle
                    mode={isSessionBinding(row.value) ? "session" : "literal"}
                    onValueChange={(mode) =>
                      patchRow(index, {
                        value:
                          mode === "session"
                            ? { source: "SESSION", path: "" }
                            : "",
                      })
                    }
                  />
                </>
              )}
            </div>
          </div>
        ))}
      </FieldGroup>
      <Button
        onClick={() =>
          commit({
            ...draft,
            rows: [...draft.rows, { path: "", operator: "EQ", value: "" }],
          })
        }
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {t("addCondition")}
      </Button>
      <FieldDescription className="text-[10px]">
        {draft.rows.length ? t("conditionHelp") : t("conditionEmpty")}
      </FieldDescription>
      {interpolationModes(field) && <InterpolationHint />}
    </Field>
  );
}

/**
 * The buttons a `HUMAN_CHOICE` step offers, edited as labelled rows instead of
 * an options array typed as JSON. Entries the runtime would not accept as
 * `{ label, description }` keep the JSON control.
 */
function ChoiceOptionsField(props: FieldProps) {
  const { field, value, onChange } = props;
  const t = useTranslations("workflows");
  const rows = parseChoiceOptions(value);

  if (!rows) {
    return (
      <div className="space-y-1.5">
        <JsonField {...props} />
        <FieldDescription className="text-[10px]">
          {t("choiceOptionsAdvanced")}
        </FieldDescription>
      </div>
    );
  }

  const commit = (next: ChoiceOptionRow[]) =>
    onChange(serializeChoiceOptions(next));
  const patchRow = (index: number, changes: Partial<ChoiceOptionRow>) =>
    commit(
      rows.map((row, position) =>
        position === index ? { ...row, ...changes } : row,
      ),
    );

  return (
    <Field>
      <FieldLabel className="text-xs">{field.label}</FieldLabel>
      <FieldGroup className="gap-1.5">
        {rows.map((row, index) => (
          <div className="space-y-1.5 rounded-lg border p-2" key={index}>
            <div className="flex items-center gap-2">
              <Input
                aria-label={t("choiceOptionLabel")}
                className="min-w-0 flex-1"
                onChange={(event) =>
                  patchRow(index, { label: event.target.value })
                }
                placeholder={t("choiceOptionLabel")}
                value={row.label}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={t("removeRow")}
                    className="size-7 shrink-0"
                    onClick={() =>
                      commit(
                        rows.filter((_entry, position) => position !== index),
                      )
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("removeRow")}</TooltipContent>
              </Tooltip>
            </div>
            <Input
              aria-label={t("choiceOptionDescription")}
              className="text-xs"
              onChange={(event) =>
                patchRow(index, { description: event.target.value })
              }
              placeholder={t("choiceOptionDescription")}
              value={row.description}
            />
          </div>
        ))}
      </FieldGroup>
      <Button
        onClick={() => commit([...rows, { label: "", description: "" }])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {t("addChoiceOption")}
      </Button>
      <FieldDescription className="text-[10px]">
        {rows.length ? t("choiceOptionsHelp") : t("choiceOptionsEmpty")}
      </FieldDescription>
      {interpolationModes(field) && <InterpolationHint />}
    </Field>
  );
}

/**
 * The options a choice trigger offers, each of which becomes an item in the
 * menu under the run button and an output handle on the trigger card.
 *
 * The key is what the graph connects to, so it must survive a rename: it
 * follows the label only while it still matches the label it was derived from,
 * and stops the moment the author edits it directly.
 */
function TriggerChoicesField(props: FieldProps) {
  const { field, value, onChange } = props;
  const t = useTranslations("workflows");
  const rows = parseTriggerChoices(value);

  if (!rows) {
    return (
      <div className="space-y-1.5">
        <JsonField {...props} />
        <FieldDescription className="text-[10px]">
          {t("triggerChoicesAdvanced")}
        </FieldDescription>
      </div>
    );
  }

  const commit = (next: TriggerChoiceRow[]) =>
    onChange(serializeTriggerChoices(next));
  const patchRow = (index: number, changes: Partial<TriggerChoiceRow>) =>
    commit(
      rows.map((row, position) =>
        position === index ? { ...row, ...changes } : row,
      ),
    );
  const renameLabel = (index: number, label: string) => {
    const row = rows[index]!;
    const tracking =
      !row.key || row.key === triggerChoiceKeyFromLabel(row.label);
    patchRow(index, {
      label,
      ...(tracking ? { key: triggerChoiceKeyFromLabel(label) } : {}),
    });
  };
  const duplicateKey = (index: number) =>
    rows.some(
      (row, position) => position !== index && row.key === rows[index]!.key,
    );

  return (
    <Field>
      <FieldLabel className="text-xs">{field.label}</FieldLabel>
      <FieldGroup className="gap-1.5">
        {rows.map((row, index) => (
          <div className="space-y-1.5 rounded-lg border p-2" key={index}>
            <div className="flex items-center gap-2">
              <Input
                aria-label={t("triggerChoiceLabel")}
                className="min-w-0 flex-1"
                onChange={(event) => renameLabel(index, event.target.value)}
                placeholder={t("triggerChoiceLabel")}
                value={row.label}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={t("removeRow")}
                    className="size-7 shrink-0"
                    onClick={() =>
                      commit(
                        rows.filter((_entry, position) => position !== index),
                      )
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("removeRow")}</TooltipContent>
              </Tooltip>
            </div>
            <Input
              aria-label={t("triggerChoiceKey")}
              className="font-mono text-xs"
              onChange={(event) => patchRow(index, { key: event.target.value })}
              placeholder={t("triggerChoiceKey")}
              value={row.key}
            />
            {duplicateKey(index) && (
              <FieldError className="text-[10px]">
                {t("triggerChoiceKeyDuplicate")}
              </FieldError>
            )}
            <Input
              aria-label={t("triggerChoiceDescription")}
              className="text-xs"
              onChange={(event) =>
                patchRow(index, { description: event.target.value })
              }
              placeholder={t("triggerChoiceDescription")}
              value={row.description}
            />
          </div>
        ))}
      </FieldGroup>
      <Button
        onClick={() =>
          commit([...rows, { key: "", label: "", description: "" }])
        }
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {t("addTriggerChoice")}
      </Button>
      <FieldDescription className="text-[10px]">
        {rows.length ? t("triggerChoicesHelp") : t("triggerChoicesEmpty")}
      </FieldDescription>
    </Field>
  );
}

type ModelKeys = NonNullable<ConfigFieldDescriptor["modelKeys"]>;

const DEFAULT_MODEL_KEYS: ModelKeys = {
  provider: "provider",
  model: "model",
  effort: "effort",
};

/**
 * Combined provider/model/effort control for run steps. Two modes share the
 * three sibling keys the descriptor names in `modelKeys`:
 *
 * - Model-selector mode renders the start-session ModelEffortPicker over the
 *   live provider catalog and writes the three literal values.
 * - Variable mode binds each of the three to a session path.
 *
 * The header toggle swaps modes; the current mode is inferred from whether any
 * of the three values is a session binding. The catalog scopes to the sibling
 * worktree field when that is a literal.
 *
 * The picker reports provider, model, and effort through three separate change
 * callbacks fired in one synchronous burst. The parent commit reads a config
 * snapshot that does not update between those calls, so a naive per-call spread
 * would let the last write win and drop the other two. Accumulating into a ref
 * that survives the burst — and only resyncs to the committed config on the
 * next render — makes the final commit carry all three.
 */
function ModelField({
  field,
  config,
  onChange,
  sessionPaths,
}: {
  field: ConfigFieldDescriptor;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  sessionPaths: readonly SessionFieldInfo[];
}) {
  const t = useTranslations("workflows");
  const keys = field.modelKeys ?? DEFAULT_MODEL_KEYS;

  const latest = useRef(config);
  useEffect(() => {
    latest.current = config;
  }, [config]);

  const patch = (changes: Record<string, unknown>) => {
    const next = { ...latest.current };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    latest.current = next;
    onChange(next);
  };

  const providerValue = config[keys.provider];
  const modelValue = config[keys.model];
  const effortValue = config[keys.effort];
  const sessionMode =
    isSessionBinding(providerValue) ||
    isSessionBinding(modelValue) ||
    isSessionBinding(effortValue);

  const worktreeScope = literalScope(config, keys.scopeFrom);
  const catalog = useProviderCatalog(worktreeScope);

  const toSession = () =>
    patch({
      [keys.provider]: { source: "SESSION", path: "" },
      [keys.model]: { source: "SESSION", path: "" },
      [keys.effort]: { source: "SESSION", path: "" },
    });
  const toSelector = () =>
    patch({
      [keys.provider]: undefined,
      [keys.model]: undefined,
      [keys.effort]: undefined,
    });

  const pathOf = (value: unknown) =>
    isSessionBinding(value) ? value.path : "";
  const sessionInputs = [
    { key: keys.provider, label: t("modelProvider"), value: providerValue },
    { key: keys.model, label: t("modelModel"), value: modelValue },
    { key: keys.effort, label: t("modelEffort"), value: effortValue },
  ];
  const sessionOptions = sessionPaths.map(({ path, description }) => ({
    value: path,
    label: path,
    description,
  }));

  return (
    <Field>
      <div className="flex items-end justify-between gap-2">
        <FieldLabel className="text-xs">{field.label}</FieldLabel>
        <ValueModeToggle
          mode={sessionMode ? "session" : "literal"}
          onValueChange={(mode) =>
            mode === "session" ? toSession() : toSelector()
          }
        />
      </div>
      {sessionMode ? (
        <>
          <FieldGroup className="gap-1.5">
            {sessionInputs.map(({ key, label, value }) => (
              <Field key={key}>
                <FieldLabel className="text-[10px] text-muted-foreground">
                  {label}
                </FieldLabel>
                <SearchableSelect
                  allowCustomValue
                  ariaLabel={label}
                  emptyMessage={t("noOptions")}
                  onValueChange={(path) =>
                    patch({ [key]: { source: "SESSION", path } })
                  }
                  options={sessionOptions}
                  placeholder={t("sessionPathPlaceholder")}
                  searchPlaceholder={t("searchPlaceholder")}
                  value={pathOf(value)}
                />
              </Field>
            ))}
          </FieldGroup>
          <FieldDescription className="text-[10px]">
            {t("sessionBindingHelp")}
          </FieldDescription>
        </>
      ) : (
        <ModelEffortPicker
          catalog={catalog}
          effort={asString(literalValue(effortValue))}
          fullWidth
          model={asString(literalValue(modelValue))}
          onEffortChange={(value) => patch({ [keys.effort]: value })}
          onModelChange={(value) => patch({ [keys.model]: value })}
          onProviderChange={(value) => patch({ [keys.provider]: value })}
          provider={asString(literalValue(providerValue))}
        />
      )}
      {field.help && (
        <FieldDescription className="text-[10px]">
          {field.help}
        </FieldDescription>
      )}
    </Field>
  );
}

function ConfigFieldRow(props: FieldProps) {
  switch (props.field.control) {
    case "enum":
      return <EnumField {...props} />;
    case "text":
      return <TextField {...props} />;
    case "number":
      return <NumberField {...props} />;
    case "boolean":
      return <BooleanField {...props} />;
    case "resource":
      return <ResourceField {...props} />;
    case "resourceMulti":
      return <ResourceMultiField {...props} />;
    case "stringList":
      return <StringListField {...props} />;
    case "record":
      return <RecordField {...props} />;
    case "condition":
      return <ConditionField {...props} />;
    case "choiceOptions":
      return <ChoiceOptionsField {...props} />;
    case "triggerChoices":
      return <TriggerChoicesField {...props} />;
    case "json":
      return <JsonField {...props} />;
    default:
      return null;
  }
}

/**
 * A collapsible whole-config JSON editor. Serves as the universal escape hatch
 * for every kind: it edits any key (including ones not covered by the form) and
 * is the sole editor for kinds without a descriptor. Applies live on valid JSON.
 */
export function RawConfigEditor({
  config,
  onChange,
  defaultOpen,
  extraKeyCount,
}: {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  defaultOpen: boolean;
  extraKeyCount?: number;
}) {
  const t = useTranslations("workflows");
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState(() => JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);
  const lastEmitted = useRef(text);

  useEffect(() => {
    const serialized = JSON.stringify(config, null, 2);
    if (serialized !== lastEmitted.current) {
      setText(serialized);
      lastEmitted.current = serialized;
      setError(null);
    }
  }, [config]);

  const onText = (next: string) => {
    setText(next);
    try {
      const parsed: unknown = JSON.parse(next);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(t("configMustBeObject"));
      }
      lastEmitted.current = JSON.stringify(parsed, null, 2);
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    }
  };

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger asChild>
        <Button
          className="w-full justify-between px-0 text-xs font-medium text-muted-foreground"
          type="button"
          variant="ghost"
        >
          <span>
            {t("advancedJson")}
            {extraKeyCount
              ? ` · ${t("extraKeys", { count: extraKeyCount })}`
              : ""}
          </span>
          <ChevronDown
            className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1.5 pt-1.5">
        <Textarea
          aria-label={t("advancedJson")}
          aria-invalid={Boolean(error)}
          className="min-h-40 font-mono text-xs"
          onChange={(event) => onText(event.target.value)}
          value={text}
        />
        {error ? (
          <FieldError className="text-[10px]">{error}</FieldError>
        ) : (
          <>
            <FieldDescription className="text-[10px]">
              {t("advancedJsonHelp")}
            </FieldDescription>
            {/* The whole config is resolved before a step runs, so tokens work
                in any key here — including ones no descriptor covers. */}
            <InterpolationHint />
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Schema-driven form for a step or trigger's config. Renders one control per
 * described field, plus a raw-JSON escape hatch that also surfaces any keys not
 * covered by the descriptor. Returns null when the kind has no descriptor so the
 * parent can render the whole-config JSON fallback instead.
 */
export function ConfigFieldsEditor({
  kind,
  scope,
  config,
  onChange,
  sessionPaths,
}: {
  kind: string;
  scope: ConfigFieldScope;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  sessionPaths: readonly SessionFieldInfo[];
}) {
  const t = useTranslations("workflows");
  const descriptor = getConfigDescriptor(kind, scope);
  if (!descriptor) return null;

  const describedKeys = new Set(
    descriptor.fields.flatMap((field) =>
      field.control === "model" && field.modelKeys
        ? [
            field.modelKeys.provider,
            field.modelKeys.model,
            field.modelKeys.effort,
          ]
        : [field.key],
    ),
  );
  const extraKeys = Object.keys(config).filter(
    (key) => !describedKeys.has(key),
  );

  const update = (key: string, next: unknown) => {
    if (next === undefined) {
      const rest = { ...config };
      delete rest[key];
      onChange(rest);
      return;
    }
    onChange({ ...config, [key]: next });
  };

  return (
    <FieldGroup className="gap-3">
      <FieldTitle className="text-xs text-muted-foreground">
        {t("configuration")}
      </FieldTitle>
      {descriptor.fields.map((field) =>
        field.control === "model" ? (
          <ModelField
            config={config}
            field={field}
            key={field.key}
            onChange={onChange}
            sessionPaths={sessionPaths}
          />
        ) : (
          <ConfigFieldRow
            config={config}
            field={field}
            key={field.key}
            onChange={(next) => update(field.key, next)}
            sessionPaths={sessionPaths}
            value={config[field.key]}
          />
        ),
      )}
      <RawConfigEditor
        config={config}
        defaultOpen={false}
        extraKeyCount={extraKeys.length}
        onChange={onChange}
      />
    </FieldGroup>
  );
}
