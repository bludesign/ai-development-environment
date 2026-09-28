"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { isTransferItemSelected, transferValueLabel } from "./selection";
import {
  isWorkflowItem,
  type TransferChoice,
  type TransferItem,
} from "./types";

export function TransferSelectionTree({
  items,
  excludedKeys,
  includedKeys,
  onToggle,
  choices = [],
  onChoice,
  enableWorkflowKeys = [],
  onEnableWorkflow,
  readOnly = false,
}: {
  items: TransferItem[];
  excludedKeys: string[];
  includedKeys: string[];
  onToggle: (item: TransferItem, selected: boolean) => void;
  choices?: TransferChoice[];
  onChoice?: (choice: TransferChoice) => void;
  enableWorkflowKeys?: string[];
  onEnableWorkflow?: (key: string, enabled: boolean) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations("repositoryTransfer");
  const codebasesT = useTranslations("codebases");
  const settingLabels: Record<string, string> = {
    name: codebasesT("name"),
    description: codebasesT("repositoryDescription"),
    jiraBranchRegex: codebasesT("jiraBranchRegex"),
    keepBaseBranchUpToDate: codebasesT("keepBaseBranchUpToDate"),
  };
  const parents = new Map(items.map((item) => [item.key, item.parentKey]));
  const children = new Map<string | null, TransferItem[]>();
  for (const item of items) {
    const parent =
      item.parentKey && parents.has(item.parentKey) ? item.parentKey : null;
    children.set(parent, [...(children.get(parent) ?? []), item]);
  }
  const selected = (item: TransferItem): boolean => {
    if (!isTransferItemSelected(item.key, excludedKeys, parents)) return false;
    let current: TransferItem | undefined = item;
    while (current) {
      if (
        current.dependency &&
        current.kind !== "SETTING" &&
        !includedKeys.includes(current.key) &&
        !current.selected
      )
        return false;
      current = current.parentKey
        ? items.find((candidate) => candidate.key === current?.parentKey)
        : undefined;
    }
    return true;
  };
  const renderItems = (parent: string | null, ancestors: Set<string>) =>
    (children.get(parent) ?? []).map((item) => {
      if (ancestors.has(item.key)) return null;
      const nextAncestors = new Set(ancestors).add(item.key);
      const checked = selected(item);
      const parentItem = item.parentKey
        ? items.find(({ key }) => key === item.parentKey)
        : null;
      const parentOff = Boolean(parentItem && !selected(parentItem));
      const descendants = children.get(item.key) ?? [];
      const partial = checked && descendants.some((child) => !selected(child));
      const choice = choices.find(({ key }) => key === item.key);
      const action = choice?.action ?? item.action;
      const isConflict = item.targetId !== null && item.current !== null;
      const canCopy = [
        "APP",
        "COMMAND",
        "WORKFLOW",
        "BUILD_SCRIPT",
        "BUILD_CONFIGURATION",
      ].includes(item.kind.toUpperCase());
      const canChooseTarget =
        [
          "APP",
          "COMMAND",
          "WORKFLOW",
          "BUILD_SCRIPT",
          "BUILD_CONFIGURATION",
          "AUTO_RETRY",
          "PREPARATION",
        ].includes(item.kind.toUpperCase()) &&
        (item.candidates?.length ?? 0) > 0;
      const id = `transfer-item-${item.key}`;
      return (
        <div className="space-y-3" key={item.key}>
          <div className="rounded-lg border p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id={id}
                checked={partial ? "indeterminate" : checked}
                disabled={readOnly || parentOff}
                onCheckedChange={(value) => onToggle(item, value === true)}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={id} className="break-words">
                    {item.kind === "SETTING"
                      ? (settingLabels[item.key.split("/").at(-1) ?? ""] ??
                        item.label)
                      : item.label}
                  </Label>
                  {item.dependency && item.kind !== "SETTING" && (
                    <Badge variant="secondary">{t("dependency")}</Badge>
                  )}
                  {onChoice && (
                    <Badge variant={isConflict ? "outline" : "secondary"}>
                      {t(isConflict ? "existing" : "newItem")}
                    </Badge>
                  )}
                </div>
                {item.warnings.map((warning, index) => (
                  <p
                    className="text-sm text-amber-700 dark:text-amber-300"
                    key={index}
                  >
                    {warning}
                  </p>
                ))}
                {item.affectedRepositories.length > 0 && (
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    {t("affectsRepositories", {
                      names: item.affectedRepositories.join(", "),
                    })}
                  </p>
                )}
                {onChoice &&
                  (isConflict || canCopy || canChooseTarget) &&
                  checked && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={`${id}-action`}>{t("resolution")}</Label>
                      <select
                        id={`${id}-action`}
                        className="h-9 rounded-md border bg-background px-2"
                        disabled={readOnly}
                        value={action}
                        onChange={(event) =>
                          onChoice({
                            ...choice,
                            key: item.key,
                            action: event.target
                              .value as TransferChoice["action"],
                          })
                        }
                      >
                        <option value="IMPORT">{t("useImported")}</option>
                        <option
                          disabled={!isConflict && !choice?.targetId}
                          value="KEEP"
                        >
                          {t("keepExisting")}
                        </option>
                        {canCopy && (
                          <option value="COPY">{t("createCopy")}</option>
                        )}
                      </select>
                      {action === "COPY" && (
                        <Input
                          aria-label={t("copyName", { name: item.label })}
                          className="max-w-xs"
                          disabled={readOnly}
                          placeholder={t("newName")}
                          value={choice?.name ?? ""}
                          onChange={(event) =>
                            onChoice({
                              ...choice,
                              key: item.key,
                              action,
                              name: event.target.value,
                            })
                          }
                        />
                      )}
                      {action !== "COPY" && canChooseTarget && (
                        <div className="w-full space-y-1">
                          <Label htmlFor={`${id}-target`}>
                            {t("existingDestination")}
                          </Label>
                          <select
                            id={`${id}-target`}
                            className="h-9 w-full rounded-md border bg-background px-2"
                            disabled={readOnly}
                            value={choice?.targetId ?? item.targetId ?? ""}
                            onChange={(event) =>
                              onChoice({
                                ...choice,
                                key: item.key,
                                action,
                                targetId: event.target.value || undefined,
                              })
                            }
                          >
                            <option value="">{t("matchAutomatically")}</option>
                            {item.candidates.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                {onEnableWorkflow &&
                  isWorkflowItem(item) &&
                  checked &&
                  action !== "KEEP" && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`${id}-enable`}
                        checked={enableWorkflowKeys.includes(item.key)}
                        disabled={readOnly}
                        onCheckedChange={(value) =>
                          onEnableWorkflow(item.key, value === true)
                        }
                      />
                      <Label htmlFor={`${id}-enable`}>
                        {t("enableWorkflow")}
                      </Label>
                    </div>
                  )}
                {(item.current !== null || item.incoming !== null) && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">
                      {t(onChoice ? "viewChanges" : "viewContents")}
                    </summary>
                    <div
                      className={`mt-2 grid gap-3 ${onChoice && isConflict ? "md:grid-cols-2" : ""}`}
                    >
                      {onChoice && isConflict && (
                        <div>
                          <p className="mb-1 font-medium">{t("current")}</p>
                          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs">
                            {transferValueLabel(item.current)}
                          </pre>
                        </div>
                      )}
                      <div>
                        <p className="mb-1 font-medium">
                          {t(onChoice ? "incoming" : "contents")}
                        </p>
                        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs">
                          {transferValueLabel(item.incoming)}
                        </pre>
                      </div>
                    </div>
                  </details>
                )}
              </div>
            </div>
          </div>
          {descendants.length > 0 && (
            <div className="ml-3 space-y-3 border-l pl-3">
              {renderItems(item.key, nextAncestors)}
            </div>
          )}
        </div>
      );
    });
  return <div className="space-y-3">{renderItems(null, new Set())}</div>;
}
