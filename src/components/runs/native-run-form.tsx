"use client";

import { useTranslations } from "next-intl";
import {
  runFormFieldActive,
  type RunFormValue,
  type RunQuestionField,
} from "@ai-development-environment/agent-contract/run-forms";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type NativeFormDraft = Record<string, RunFormValue | undefined>;

/** Resolve defaults and visibility in native field order, without inventing empty answers. */
export function nativeFormValues(
  fields: RunQuestionField[],
  draft: NativeFormDraft,
): Record<string, RunFormValue> {
  const result: Record<string, RunFormValue> = Object.create(null);
  for (const field of fields) {
    if (!runFormFieldActive(field, result)) continue;
    const value = Object.hasOwn(draft, field.key)
      ? draft[field.key]
      : field.type !== "external"
        ? field.default
        : undefined;
    if (value !== undefined) result[field.key] = value;
  }
  return result;
}

export function NativeRunForm({
  fields,
  draft,
  onChange,
  readOnly = false,
}: {
  fields: RunQuestionField[];
  draft: NativeFormDraft;
  onChange: (draft: NativeFormDraft) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations("runs.form");
  const values = nativeFormValues(
    fields,
    readOnly
      ? Object.assign(
          Object.fromEntries(fields.map((field) => [field.key, undefined])),
          draft,
        )
      : draft,
  );
  const change = (key: string, value: RunFormValue | undefined) =>
    onChange({ ...draft, [key]: value });
  return (
    <div className="space-y-5">
      {fields.map((field) => {
        if (
          ("hidden" in field && field.hidden) ||
          !runFormFieldActive(field, values)
        )
          return null;
        const value = values[field.key];
        const label = field.title || field.key;
        const required = "required" in field && field.required;
        const options = "options" in field ? field.options : undefined;
        const selected = Array.isArray(value) ? value : [];
        const id = `native-field-${field.key}`;
        return (
          <div key={field.key} className="space-y-2">
            <label className="block font-medium" htmlFor={id}>
              {label}
              {required ? ` (${t("required")})` : ""}
            </label>
            {field.description && (
              <p className="text-sm text-muted-foreground">
                {field.description}
              </p>
            )}
            {readOnly ? (
              <p className="whitespace-pre-wrap text-sm">
                {value === undefined
                  ? "—"
                  : typeof value === "boolean"
                    ? t(value ? "yes" : "no")
                    : Array.isArray(value)
                      ? value
                          .map(
                            (entry) =>
                              options?.find((option) => option.value === entry)
                                ?.label ?? entry,
                          )
                          .join(", ")
                      : (options?.find((option) => option.value === value)
                          ?.label ?? String(value))}
              </p>
            ) : field.type === "external" ? (
              <>
                <a
                  className="text-primary underline"
                  href={field.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("openLink")}
                </a>
                <label className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={value === true}
                    onCheckedChange={(checked) =>
                      change(field.key, checked === true ? true : undefined)
                    }
                  />
                  {t("acknowledge")}
                </label>
              </>
            ) : field.type === "boolean" ? (
              <Select
                value={typeof value === "boolean" ? String(value) : ""}
                onValueChange={(next) =>
                  change(
                    field.key,
                    next === "unset" ? undefined : next === "true",
                  )
                }
              >
                <SelectTrigger id={id} aria-label={label}>
                  <SelectValue placeholder={t("choose")} />
                </SelectTrigger>
                <SelectContent>
                  {!required && (
                    <SelectItem value="unset">{t("unanswered")}</SelectItem>
                  )}
                  <SelectItem value="true">{t("yes")}</SelectItem>
                  <SelectItem value="false">{t("no")}</SelectItem>
                </SelectContent>
              </Select>
            ) : field.type === "number" || field.type === "integer" ? (
              <Input
                id={id}
                aria-label={label}
                type="number"
                step={field.type === "integer" ? 1 : "any"}
                min={field.minimum}
                max={field.maximum}
                required={required}
                value={typeof value === "number" ? value : ""}
                onChange={(event) =>
                  change(
                    field.key,
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                  )
                }
              />
            ) : field.type === "multiselect" ? (
              <>
                {field.options.map((option) => (
                  <label
                    className="flex items-start gap-3 rounded-lg border p-3"
                    key={option.value}
                  >
                    <Checkbox
                      checked={selected.includes(option.value)}
                      onCheckedChange={(checked) =>
                        change(
                          field.key,
                          checked
                            ? [...selected, option.value]
                            : selected.filter(
                                (entry) => entry !== option.value,
                              ),
                        )
                      }
                    />
                    <span>
                      <span className="block font-medium">{option.label}</span>
                      {option.description && (
                        <span className="text-sm text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {field.custom && (
                  <Textarea
                    aria-label={t("custom")}
                    placeholder={t("customMultiple")}
                    value={selected
                      .filter(
                        (entry) =>
                          !field.options.some(
                            (option) => option.value === entry,
                          ),
                      )
                      .join("\n")}
                    onChange={(event) =>
                      change(field.key, [
                        ...selected.filter((entry) =>
                          field.options.some(
                            (option) => option.value === entry,
                          ),
                        ),
                        ...event.target.value.split("\n").filter(Boolean),
                      ])
                    }
                  />
                )}
              </>
            ) : field.type === "string" ? (
              <>
                {field.options?.map((option) => (
                  <label
                    className="flex items-start gap-3 rounded-lg border p-3"
                    key={option.value}
                  >
                    <Checkbox
                      checked={value === option.value}
                      onCheckedChange={(checked) =>
                        change(field.key, checked ? option.value : undefined)
                      }
                    />
                    <span>
                      <span className="block font-medium">{option.label}</span>
                      {option.description && (
                        <span className="text-sm text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
                {(!field.options || field.custom) && (
                  <Input
                    id={id}
                    aria-label={label}
                    required={required}
                    type={
                      field.format === "email"
                        ? "email"
                        : field.format === "uri"
                          ? "url"
                          : field.format === "date"
                            ? "date"
                            : "text"
                    }
                    placeholder={
                      field.placeholder ??
                      (field.options ? t("custom") : undefined)
                    }
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    pattern={field.pattern}
                    value={
                      typeof value === "string" &&
                      !field.options?.some((option) => option.value === value)
                        ? value
                        : ""
                    }
                    onChange={(event) =>
                      change(field.key, event.target.value || undefined)
                    }
                  />
                )}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
