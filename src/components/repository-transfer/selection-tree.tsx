"use client";

import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
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

import { isTransferItemSelected, transferValueLabel } from "./selection";
import {
  isWorkflowItem,
  type TransferChoice,
  type TransferItem,
} from "./types";

const AUTOMATIC_TARGET = "__automatic__";

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
                      <Select
                        disabled={readOnly}
                        value={action}
                        onValueChange={(value) =>
                          onChoice({
                            ...choice,
                            key: item.key,
                            action: value as TransferChoice["action"],
                          })
                        }
                      >
                        <SelectTrigger id={`${id}-action`} className="min-w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" align="start">
                          <SelectItem value="IMPORT">
                            {t("useImported")}
                          </SelectItem>
                          <SelectItem
                            disabled={!isConflict && !choice?.targetId}
                            value="KEEP"
                          >
                            {t("keepExisting")}
                          </SelectItem>
                          {canCopy && (
                            <SelectItem value="COPY">
                              {t("createCopy")}
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
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
                          <Select
                            disabled={readOnly}
                            value={
                              choice && Object.hasOwn(choice, "targetId")
                                ? (choice.targetId ?? AUTOMATIC_TARGET)
                                : (item.targetId ?? AUTOMATIC_TARGET)
                            }
                            onValueChange={(value) =>
                              onChoice({
                                ...choice,
                                key: item.key,
                                action,
                                targetId:
                                  value === AUTOMATIC_TARGET
                                    ? undefined
                                    : value,
                              })
                            }
                          >
                            <SelectTrigger
                              id={`${id}-target`}
                              className="w-full"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper" align="start">
                              <SelectItem value={AUTOMATIC_TARGET}>
                                {t("matchAutomatically")}
                              </SelectItem>
                              {item.candidates.map((candidate) => (
                                <SelectItem
                                  key={candidate.id}
                                  value={candidate.id}
                                >
                                  {candidate.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
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
                  <Collapsible className="text-sm">
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="group -ml-2 text-muted-foreground"
                      >
                        <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                        {t(onChoice ? "viewChanges" : "viewContents")}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent
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
                    </CollapsibleContent>
                  </Collapsible>
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
