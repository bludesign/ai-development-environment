"use client";

import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { SearchableSelect } from "@/components/common/searchable-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SessionFieldInfo } from "@/lib/workflows/session-schema";

import { getConfigDescriptor } from "./descriptors";
import type { ConfigFieldDescriptor, ConfigFieldScope } from "./types";
import { useResourceOptions } from "./use-resource-options";
import { ValueModeField, literalValue } from "./value-mode-field";

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

type FieldProps = {
  field: ConfigFieldDescriptor;
  config: Record<string, unknown>;
  value: unknown;
  onChange: (next: unknown) => void;
  sessionPaths: readonly SessionFieldInfo[];
};

function EnumField({ field, value, onChange }: FieldProps) {
  const t = useTranslations("workflows");
  const options = field.options?.kind === "static" ? field.options.options : [];
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label}</Label>
      <Select
        onValueChange={(next) => onChange(next)}
        value={asString(literalValue(value))}
      >
        <SelectTrigger className="w-full">
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
        <p className="text-[10px] text-muted-foreground">{field.help}</p>
      )}
    </div>
  );
}

function TextField({ field, value, onChange, sessionPaths }: FieldProps) {
  return (
    <ValueModeField
      help={field.help}
      label={field.label}
      onChange={onChange}
      sessionEnabled={sessionModes(field)}
      sessionPaths={sessionPaths}
      value={value}
    >
      {(current, onLiteral) =>
        field.multiline ? (
          <Textarea
            className="min-h-20 text-sm"
            onChange={(event) => onLiteral(event.target.value)}
            placeholder={field.placeholder}
            value={asString(current)}
          />
        ) : (
          <Input
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
      {(current, onLiteral) => (
        <Input
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
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={literalValue(value) === true}
          id={id}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <Label className="text-xs" htmlFor={id}>
          {field.label}
        </Label>
      </div>
      {field.help && (
        <p className="text-[10px] text-muted-foreground">{field.help}</p>
      )}
    </div>
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
  const { options, loading, fallback } = useResourceOptions(
    source?.resource ?? "codebase",
    scope,
  );
  return (
    <ValueModeField
      help={field.help}
      label={field.label}
      onChange={onChange}
      sessionEnabled={sessionModes(field)}
      sessionPaths={sessionPaths}
      value={value}
    >
      {(current, onLiteral) =>
        fallback || loading ? (
          <Input
            onChange={(event) => onLiteral(event.target.value)}
            placeholder={field.placeholder ?? t("selectPlaceholder")}
            value={asString(current)}
          />
        ) : (
          <SearchableSelect
            ariaLabel={field.label}
            emptyMessage={t("noOptions")}
            onValueChange={onLiteral}
            options={options}
            placeholder={t("selectPlaceholder")}
            searchPlaceholder={t("searchPlaceholder")}
            value={asString(current)}
          />
        )
      }
    </ValueModeField>
  );
}

function ResourceMultiField({ field, config, value, onChange }: FieldProps) {
  const t = useTranslations("workflows");
  const source = field.options?.kind === "resource" ? field.options : null;
  const scope = literalScope(config, source?.scopeFrom);
  const { options, fallback } = useResourceOptions(
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
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label}</Label>
      <div className="space-y-1.5">
        {selected.map((id) => (
          <div className="flex items-center gap-2" key={id}>
            <span className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1 text-xs">
              {labelFor(id)}
            </span>
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
          </div>
        ))}
        {fallback ? (
          <Input
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add(event.currentTarget.value.trim());
                event.currentTarget.value = "";
              }
            }}
            placeholder={field.placeholder ?? t("addRow")}
          />
        ) : (
          <SearchableSelect
            ariaLabel={field.label}
            emptyMessage={t("noOptions")}
            onValueChange={add}
            options={remaining}
            placeholder={t("addRow")}
            searchPlaceholder={t("searchPlaceholder")}
            value=""
          />
        )}
      </div>
      {field.help && (
        <p className="text-[10px] text-muted-foreground">{field.help}</p>
      )}
    </div>
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
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label}</Label>
      <div className="space-y-1.5">
        {items.map((entry, index) => (
          <div className="flex items-center gap-2" key={index}>
            <Input
              onChange={(event) => setItem(index, event.target.value)}
              placeholder={field.placeholder}
              value={entry}
            />
            <Button
              aria-label={t("removeRow")}
              className="size-7 shrink-0"
              onClick={() => removeItem(index)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        onClick={() => onChange([...items, ""])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {t("addRow")}
      </Button>
      {field.help && (
        <p className="text-[10px] text-muted-foreground">{field.help}</p>
      )}
    </div>
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
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label}</Label>
      <div className="space-y-1.5">
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
            <Button
              aria-label={t("removeRow")}
              className="size-7 shrink-0"
              onClick={() =>
                commit(entries.filter((_pair, position) => position !== index))
              }
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        onClick={() => commit([...entries, ["", ""] as const])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="size-3.5" /> {t("addRow")}
      </Button>
      {field.help && (
        <p className="text-[10px] text-muted-foreground">{field.help}</p>
      )}
    </div>
  );
}

function JsonField({ field, value, onChange }: FieldProps) {
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
    <div className="space-y-1.5">
      <Label className="text-xs">{field.label}</Label>
      <Textarea
        className="min-h-24 font-mono text-xs"
        onChange={(event) => onText(event.target.value)}
        placeholder={field.placeholder}
        value={text}
      />
      {error ? (
        <p className="text-[10px] text-destructive">{error}</p>
      ) : (
        field.help && (
          <p className="text-[10px] text-muted-foreground">{field.help}</p>
        )
      )}
    </div>
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
          className="min-h-40 font-mono text-xs"
          onChange={(event) => onText(event.target.value)}
          value={text}
        />
        {error ? (
          <p className="text-[10px] text-destructive">{error}</p>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            {t("advancedJsonHelp")}
          </p>
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

  const describedKeys = new Set(descriptor.fields.map((field) => field.key));
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
    <div className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        {t("configuration")}
      </p>
      {descriptor.fields.map((field) => (
        <ConfigFieldRow
          config={config}
          field={field}
          key={field.key}
          onChange={(next) => update(field.key, next)}
          sessionPaths={sessionPaths}
          value={config[field.key]}
        />
      ))}
      <RawConfigEditor
        config={config}
        defaultOpen={false}
        extraKeyCount={extraKeys.length}
        onChange={onChange}
      />
    </div>
  );
}
