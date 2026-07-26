"use client";

import { useTranslations } from "next-intl";
import { useMemo, type ReactNode } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldGroup, FieldTitle } from "@/components/ui/field";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getConfigDescriptor } from "@/lib/workflows/config-descriptors";
import {
  computeWorkflowPathAvailability,
  resourceManualSeedPaths,
} from "@/lib/workflows/definition";
import { expandSessionPaths } from "@/lib/workflows/session-schema";

import type {
  WorkflowCatalog,
  WorkflowDefinition,
  WorkflowNodeDefinition,
  WorkflowTriggerDefinition,
} from "./types";
import { useWorkflowLabels } from "./workflow-labels";
import {
  buildPathLookup,
  displayProvidedPaths,
} from "./workflow-inspector-data";

type ConfigRow = { key: string; label: string; value: unknown };

function configRows(
  item: WorkflowNodeDefinition | WorkflowTriggerDefinition,
  scope: "step" | "trigger",
): ConfigRow[] {
  const descriptor = getConfigDescriptor(item.kind, scope);
  if (!descriptor)
    return Object.entries(item.config).map(([key, value]) => ({
      key,
      label: key,
      value,
    }));

  const described = new Set<string>();
  const rows: ConfigRow[] = [];
  for (const field of descriptor.fields) {
    if (
      field.visibleWhen &&
      item.config[field.visibleWhen.key] !== field.visibleWhen.equals
    )
      continue;
    if (field.control === "model" && field.modelKeys) {
      const keys = [
        field.modelKeys.provider,
        field.modelKeys.model,
        field.modelKeys.effort,
      ];
      keys.forEach((key) => described.add(key));
      rows.push({
        key: field.key,
        label: field.label,
        value: Object.fromEntries(
          keys.map((key) => [key, item.config[key] ?? null]),
        ),
      });
      continue;
    }
    described.add(field.key);
    const raw = item.config[field.key] ?? field.default;
    const staticOptions =
      field.options?.kind === "static" ? field.options.options : [];
    const option = staticOptions.find(({ value }) => value === raw);
    rows.push({
      key: field.key,
      label: field.label,
      value: option?.label ?? raw,
    });
  }
  for (const [key, value] of Object.entries(item.config)) {
    if (!described.has(key)) rows.push({ key, label: key, value });
  }
  return rows;
}

function ReadonlyValue({ value, notSet }: { value: unknown; notSet: string }) {
  let content: ReactNode;
  if (value === undefined || value === null || value === "") content = notSet;
  else if (typeof value === "boolean") content = value ? "Yes" : "No";
  else if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { source?: unknown }).source === "SESSION"
  )
    content = (
      <code>{String((value as { path?: unknown }).path ?? notSet)}</code>
    );
  else if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry !== "object")
  )
    content = value.length ? value.join(", ") : notSet;
  else if (typeof value === "object")
    content = (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-2 font-mono text-[11px]">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  else content = String(value);
  return <>{content}</>;
}

function PathList({
  empty,
  paths,
}: {
  empty: string;
  paths: Array<{ path: string; description?: string }>;
}) {
  if (!paths.length)
    return (
      <Empty className="py-5">
        <EmptyHeader>
          <EmptyDescription>{empty}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <ItemGroup className="gap-1 rounded-lg border bg-muted/30 p-2">
      {paths.map(({ path, description }) => (
        <Item className="px-1 py-0" key={path} size="xs">
          <ItemContent>
            <ItemTitle>
              <code className="text-[11px]">{path}</code>
            </ItemTitle>
            {description && (
              <ItemDescription className="text-[10px]">
                {description}
              </ItemDescription>
            )}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}

export function WorkflowReadonlyInspector({
  catalog,
  definition,
  onOpenChange,
  selectedId,
}: {
  catalog: WorkflowCatalog | null;
  definition: WorkflowDefinition;
  onOpenChange: (open: boolean) => void;
  selectedId: string | null;
}) {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
  const selectedNode =
    definition.nodes.find(({ id }) => id === selectedId) ?? null;
  const selectedTrigger =
    definition.triggers.find(({ id }) => id === selectedId) ?? null;
  const selected = selectedNode ?? selectedTrigger;
  const entry = selectedNode
    ? catalog?.steps.find(({ kind }) => kind === selectedNode.kind)
    : catalog?.triggers.find(({ kind }) => kind === selectedTrigger?.kind);
  const availability = useMemo(
    () => computeWorkflowPathAvailability(definition, buildPathLookup(catalog)),
    [catalog, definition],
  );
  const additions = useMemo(() => {
    if (selectedNode)
      return displayProvidedPaths(selectedNode.id, availability.provides);
    if (!selectedTrigger) return [];
    const seedPaths = [
      ...(catalog?.triggers.find(({ kind }) => kind === selectedTrigger.kind)
        ?.seedPaths ?? []),
      ...resourceManualSeedPaths(selectedTrigger.kind, selectedTrigger.config),
    ];
    return expandSessionPaths(seedPaths);
  }, [availability, catalog, selectedNode, selectedTrigger]);
  const required = useMemo(() => {
    if (!selectedNode) return [];
    const catalogPaths =
      catalog?.steps.find(({ kind }) => kind === selectedNode.kind)
        ?.requiredPaths ?? [];
    return expandSessionPaths([
      ...new Set([...catalogPaths, ...selectedNode.requiredPaths]),
    ]);
  }, [catalog, selectedNode]);
  const rows = selected
    ? configRows(selected, selectedNode ? "step" : "trigger")
    : [];

  return (
    <Sheet onOpenChange={onOpenChange} open={Boolean(selected)}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        {selected ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {selected.name ?? labels.kind(selected.kind)}
              </SheetTitle>
              <SheetDescription>
                {entry?.description ?? labels.kind(selected.kind)}
              </SheetDescription>
            </SheetHeader>
            <FieldGroup className="gap-4 px-4 pb-4">
              {entry?.details && (
                <p className="rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                  {entry.details}
                </p>
              )}
              <Field>
                <FieldTitle>{t("configuration")}</FieldTitle>
                {rows.length ? (
                  <dl className="space-y-3 rounded-lg border bg-muted/20 p-3">
                    {rows.map((row) => (
                      <div className="space-y-1" key={row.key}>
                        <dt className="text-xs font-medium">{row.label}</dt>
                        <dd className="m-0 text-xs text-muted-foreground">
                          <ReadonlyValue
                            value={row.value}
                            notSet={t("notSet")}
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <Empty className="py-5">
                    <EmptyHeader>
                      <EmptyTitle>{t("noConfiguration")}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
              </Field>
              <Field>
                <FieldTitle>
                  {selectedNode ? t("addsToSession") : t("seedsSession")}
                </FieldTitle>
                <PathList empty={t("addsToSessionEmpty")} paths={additions} />
              </Field>
              {selectedNode && (
                <>
                  <Field>
                    <FieldTitle>{t("requiredPaths")}</FieldTitle>
                    <PathList empty={t("noRequiredPaths")} paths={required} />
                  </Field>
                  <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-3">
                    <div>
                      <dt className="text-xs font-medium">
                        {t("maxAttempts")}
                      </dt>
                      <dd className="m-0 text-xs text-muted-foreground">
                        {selectedNode.retry.maxAttempts}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium">
                        {t("retryStrategy")}
                      </dt>
                      <dd className="m-0 text-xs text-muted-foreground">
                        {t(`retryStrategies.${selectedNode.retry.strategy}`)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium">{t("retryDelay")}</dt>
                      <dd className="m-0 text-xs text-muted-foreground">
                        {t("seconds", {
                          count: selectedNode.retry.delaySeconds,
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium">
                        {t("failurePolicy")}
                      </dt>
                      <dd className="m-0 text-xs text-muted-foreground">
                        {t(`failure.${selectedNode.failurePolicy}`)}
                      </dd>
                    </div>
                  </dl>
                </>
              )}
            </FieldGroup>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
