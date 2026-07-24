"use client";

import { Braces, PenLine } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";

import { SearchableSelect } from "@/components/common/searchable-select";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SessionFieldInfo } from "@/lib/workflows/session-schema";

export type FieldValueMode = "literal" | "session";

type SessionBinding = { source: "SESSION"; path: string };

export function isSessionBinding(value: unknown): value is SessionBinding {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).source === "SESSION"
  );
}

function isLiteralWrapper(
  value: unknown,
): value is { source: "LITERAL"; value: unknown } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).source === "LITERAL"
  );
}

/** Unwraps a `{source:"LITERAL",value}` envelope to the bare value it carries. */
export function literalValue(value: unknown): unknown {
  return isLiteralWrapper(value) ? value.value : value;
}

export function detectValueMode(value: unknown): FieldValueMode {
  return isSessionBinding(value) ? "session" : "literal";
}

export function ValueModeToggle({
  mode,
  onValueChange,
}: {
  mode: FieldValueMode;
  onValueChange: (mode: FieldValueMode) => void;
}) {
  const t = useTranslations("workflows");
  return (
    <ToggleGroup
      aria-label={t("valueModeToggle")}
      onValueChange={(value) => {
        if (value === "literal" || value === "session") onValueChange(value);
      }}
      size="sm"
      spacing={0}
      type="single"
      value={mode}
      variant="outline"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem
            aria-label={t("valueModeLiteral")}
            className="size-7 px-0"
            value="literal"
          >
            <PenLine className="size-3.5" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>{t("valueModeLiteral")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem
            aria-label={t("valueModeSession")}
            className="size-7 px-0"
            value="session"
          >
            <Braces className="size-3.5" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>{t("valueModeSession")}</TooltipContent>
      </Tooltip>
    </ToggleGroup>
  );
}

/**
 * Wraps a field control with a compact literal/session mode switch. When the
 * field allows session bindings, an icon toggle sits to the right of the label.
 * Session mode stores `{ source: "SESSION", path }` (matching
 * resolveWorkflowValue); literal mode stores the bare value the child edits.
 */
export function ValueModeField({
  label,
  help,
  sessionEnabled,
  value,
  onChange,
  sessionPaths,
  children,
}: {
  label: string;
  help?: string;
  sessionEnabled: boolean;
  value: unknown;
  onChange: (next: unknown) => void;
  sessionPaths: readonly SessionFieldInfo[];
  children: (
    current: unknown,
    onLiteralChange: (next: unknown) => void,
    controlId: string,
  ) => ReactNode;
}) {
  const t = useTranslations("workflows");
  const controlId = useId();
  const mode = detectValueMode(value);
  const sessionOptions = sessionPaths.map(({ path, description }) => ({
    value: path,
    label: path,
    description,
  }));

  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel className="text-xs" htmlFor={controlId}>
          {label}
        </FieldLabel>
        {sessionEnabled && (
          <ValueModeToggle
            mode={mode}
            onValueChange={(nextMode) =>
              onChange(
                nextMode === "session" ? { source: "SESSION", path: "" } : "",
              )
            }
          />
        )}
      </div>
      {mode === "session" ? (
        <>
          <SearchableSelect
            allowCustomValue
            ariaLabel={t("sessionBindingLabel")}
            emptyMessage={t("noOptions")}
            onValueChange={(path) => onChange({ source: "SESSION", path })}
            options={sessionOptions}
            placeholder={t("sessionPathPlaceholder")}
            searchPlaceholder={t("searchPlaceholder")}
            value={isSessionBinding(value) ? value.path : ""}
          />
          <FieldDescription className="text-[10px]">
            {t("sessionBindingHelp")}
          </FieldDescription>
        </>
      ) : (
        <>
          {children(literalValue(value), onChange, controlId)}
          {help && (
            <FieldDescription className="text-[10px]">{help}</FieldDescription>
          )}
        </>
      )}
    </Field>
  );
}
