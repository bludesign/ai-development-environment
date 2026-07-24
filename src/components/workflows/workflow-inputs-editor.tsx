"use client";

import { ChevronDown, List, PenLine, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

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

import type { WorkflowDefinition } from "./types";

type WorkflowInput = WorkflowDefinition["inputs"][number];
type WorkflowInputType = WorkflowInput["type"];

const INPUT_TYPES: WorkflowInputType[] = [
  "STRING",
  "NUMBER",
  "BOOLEAN",
  "JSON",
  "ID",
];

/**
 * Known resource kinds a typed input can accept. These mirror the literals the
 * resource pages pass to the RESOURCE_MANUAL trigger (see
 * `src/app/[locale]/*​/page.tsx` → workflow-resource-panel). The backend matches
 * `acceptedResourceKind` case-insensitively, so the raw/manual mode below still
 * allows any custom or future kind that isn't in this list.
 */
const RESOURCE_KINDS = [
  "BUILD",
  "CODEBASE",
  "JIRA_TICKET",
  "AGENT_RUN",
  "PULL_REQUEST",
  "WORKTREE",
] as const;

function isKnownResourceKind(value: string | undefined): boolean {
  return Boolean(value) && RESOURCE_KINDS.includes(value as never);
}

function generateInputId(): string {
  return `input-${crypto.randomUUID()}`;
}

function DefaultValueEditor({
  type,
  value,
  onChange,
}: {
  type: WorkflowInputType;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const t = useTranslations("workflows");
  const id = useId();

  if (type === "BOOLEAN") {
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          checked={value === true}
          id={id}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <Label className="text-xs" htmlFor={id}>
          {t("inputDefaultLabel")}
        </Label>
      </div>
    );
  }

  if (type === "JSON") {
    return (
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor={id}>
          {t("inputDefaultLabel")}
        </Label>
        <Textarea
          className="min-h-16 font-mono text-xs"
          id={id}
          onChange={(event) => {
            try {
              onChange(
                event.target.value === ""
                  ? undefined
                  : JSON.parse(event.target.value),
              );
            } catch {
              // Ignore invalid JSON while typing; keep the last valid value.
            }
          }}
          defaultValue={value === undefined ? "" : JSON.stringify(value)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={id}>
        {t("inputDefaultLabel")}
      </Label>
      <Input
        id={id}
        onChange={(event) =>
          onChange(
            event.target.value === ""
              ? undefined
              : type === "NUMBER"
                ? Number(event.target.value)
                : event.target.value,
          )
        }
        type={type === "NUMBER" ? "number" : "text"}
        value={
          value === undefined || value === null
            ? ""
            : typeof value === "string" || typeof value === "number"
              ? String(value)
              : ""
        }
      />
    </div>
  );
}

function ResourceKindField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const t = useTranslations("workflows");
  const [manual, setManual] = useState(
    () => Boolean(value) && !isKnownResourceKind(value),
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[10px] text-muted-foreground">
          {t("inputResourceKindLabel")}
        </Label>
        <Button
          aria-label={t("resourceKindToggle")}
          className="size-6"
          onClick={() => setManual((current) => !current)}
          size="icon"
          title={manual ? t("resourceKindChoose") : t("resourceKindManual")}
          type="button"
          variant="ghost"
        >
          {manual ? (
            <List className="size-3.5" />
          ) : (
            <PenLine className="size-3.5" />
          )}
        </Button>
      </div>
      {manual ? (
        <Input
          onChange={(event) =>
            onChange(event.target.value === "" ? undefined : event.target.value)
          }
          placeholder="WORKTREE"
          value={value ?? ""}
        />
      ) : (
        <Select
          onValueChange={(next) => onChange(next)}
          value={isKnownResourceKind(value) ? value : ""}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {RESOURCE_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`inputResourceKind.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function InputRow({
  input,
  onChange,
  onRemove,
}: {
  input: WorkflowInput;
  onChange: (next: WorkflowInput) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("workflows");
  const [open, setOpen] = useState(false);
  const requiredId = useId();
  const update = <Key extends keyof WorkflowInput>(
    key: Key,
    value: WorkflowInput[Key],
  ) => onChange({ ...input, [key]: value });

  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              {t("inputLabelLabel")}
            </Label>
            <Input
              onChange={(event) => update("label", event.target.value)}
              value={input.label}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">
              {t("inputPathLabel")}
            </Label>
            <Input
              onChange={(event) => update("path", event.target.value)}
              placeholder="ticket.key"
              value={input.path}
            />
          </div>
        </div>
        <Button
          aria-label={t("removeInput")}
          className="mt-5 size-8 shrink-0"
          onClick={onRemove}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-32 flex-1 space-y-1">
          <Label className="text-[10px] text-muted-foreground">
            {t("inputTypeLabel")}
          </Label>
          <Select
            onValueChange={(value) =>
              update("type", value as WorkflowInputType)
            }
            value={input.type}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INPUT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(`inputType.${type}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pt-4">
          <Checkbox
            checked={input.required}
            id={requiredId}
            onCheckedChange={(checked) => update("required", checked === true)}
          />
          <Label className="text-xs" htmlFor={requiredId}>
            {t("inputRequiredLabel")}
          </Label>
        </div>
      </div>
      <Collapsible onOpenChange={setOpen} open={open}>
        <CollapsibleTrigger asChild>
          <Button
            className="h-7 px-0 text-[10px] text-muted-foreground"
            type="button"
            variant="ghost"
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            />
            {t("inputMoreOptions")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-1.5">
          <DefaultValueEditor
            onChange={(value) => update("defaultValue", value)}
            type={input.type}
            value={input.defaultValue}
          />
          <ResourceKindField
            onChange={(value) => update("acceptedResourceKind", value)}
            value={input.acceptedResourceKind}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * Interactive editor for a workflow's typed inputs. Replaces the raw-JSON
 * textarea: inputs become part of the definition like everything else.
 */
export function WorkflowInputsEditor({
  value,
  onChange,
}: {
  value: WorkflowInput[];
  onChange: (next: WorkflowInput[]) => void;
}) {
  const t = useTranslations("workflows");

  const addInput = () => {
    onChange([
      ...value,
      {
        id: generateInputId(),
        path: "",
        label: "",
        type: "STRING",
        required: false,
      },
    ]);
  };

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("noInputs")}</p>
      )}
      {value.map((input, index) => (
        <InputRow
          input={input}
          key={input.id}
          onChange={(next) =>
            onChange(
              value.map((entry, position) =>
                position === index ? next : entry,
              ),
            )
          }
          onRemove={() =>
            onChange(value.filter((_entry, position) => position !== index))
          }
        />
      ))}
      <Button onClick={addInput} size="sm" type="button" variant="outline">
        <Plus className="size-3.5" /> {t("addInput")}
      </Button>
    </div>
  );
}
