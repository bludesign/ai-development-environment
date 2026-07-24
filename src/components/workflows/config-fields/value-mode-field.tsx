"use client";

import { Braces, PenLine } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SessionFieldInfo } from "@/lib/workflows/session-schema";

export type FieldValueMode = "literal" | "session";

type SessionBinding = { source: "SESSION"; path: string };

function isSessionBinding(value: unknown): value is SessionBinding {
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
  ) => ReactNode;
}) {
  const t = useTranslations("workflows");
  const listId = useId();
  const mode = detectValueMode(value);

  const toggle = () => {
    if (mode === "session") {
      onChange("");
    } else {
      onChange({ source: "SESSION", path: "" });
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        {sessionEnabled && (
          <Button
            aria-label={t("valueModeToggle")}
            className="size-6"
            onClick={toggle}
            size="icon"
            title={
              mode === "session" ? t("valueModeLiteral") : t("valueModeSession")
            }
            type="button"
            variant="ghost"
          >
            {mode === "session" ? (
              <PenLine className="size-3.5" />
            ) : (
              <Braces className="size-3.5" />
            )}
          </Button>
        )}
      </div>
      {mode === "session" ? (
        <>
          <Input
            aria-label={t("sessionBindingLabel")}
            list={sessionPaths.length ? listId : undefined}
            onChange={(event) =>
              onChange({ source: "SESSION", path: event.target.value })
            }
            placeholder={t("sessionPathPlaceholder")}
            value={isSessionBinding(value) ? value.path : ""}
          />
          {sessionPaths.length > 0 && (
            <datalist id={listId}>
              {sessionPaths.map(({ path, description }) => (
                <option key={path} label={description} value={path} />
              ))}
            </datalist>
          )}
          <p className="text-[10px] text-muted-foreground">
            {t("sessionBindingHelp")}
          </p>
        </>
      ) : (
        <>
          {children(literalValue(value), onChange)}
          {help && <p className="text-[10px] text-muted-foreground">{help}</p>}
        </>
      )}
    </div>
  );
}
