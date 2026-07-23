"use client";

import { useState } from "react";
import { ChevronsUpDown, Pin, PinOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatModelLabel } from "@/lib/enum-label";
import { cn } from "@/lib/utils";

import { EffortIcon } from "./effort-icon";
import {
  modelPresetKey,
  modelPresetRailLimit,
  sameModelPreset,
  useModelPresets,
  type ModelPreset,
} from "./model-presets";
import { ProviderIcon } from "./provider-icon";

export type ProviderCatalogEntry = {
  key: string;
  label: string;
  available: boolean;
  supportsWebSearch: boolean;
  models: Array<{ id: string; label: string; efforts: string[] }>;
};

type CatalogModel = ProviderCatalogEntry["models"][number];

const providerOrder = ["CODEX", "CLAUDE", "OPENCODE"];

/**
 * `data-selected` is the transient hover/keyboard highlight and already owns
 * the row background, so the persistent "this is what you have chosen" marker
 * has to be a different channel: an inset ring, which costs no layout. The
 * trailing checkmark the primitive would otherwise draw reserves its column on
 * every row to mark one, so each row hands it a `command-shortcut` slot —
 * the escape hatch `CommandItem` already watches for — to suppress it.
 */
const checkedRow =
  "data-[checked=true]:ring-1 data-[checked=true]:ring-inset data-[checked=true]:ring-primary/40";

/**
 * Tool, model, and effort are one decision, so they are one control: a pill
 * holding the current triple that opens a searchable cross-provider palette,
 * preceded by a rail of one-click presets. The rail is what makes the palette
 * affordable — switching between the two or three setups someone actually uses
 * never costs more than a click, so the full catalog can stay behind a search
 * box instead of spread across three dropdowns.
 */
export function ModelEffortPicker({
  catalog,
  provider,
  model,
  effort,
  onProviderChange,
  onModelChange,
  onEffortChange,
  isProviderDisabled,
}: {
  catalog: ProviderCatalogEntry[];
  provider: string;
  model: string;
  effort: string;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  isProviderDisabled?: (entry: ProviderCatalogEntry) => boolean;
}) {
  const t = useTranslations("runs");
  const { rail, pinned, isPinned, togglePin, remember } = useModelPresets();
  const [open, setOpen] = useState(false);

  const providers = [...catalog].sort((left, right) => {
    const leftIndex = providerOrder.indexOf(left.key);
    const rightIndex = providerOrder.indexOf(right.key);
    return (
      (leftIndex < 0 ? providerOrder.length : leftIndex) -
      (rightIndex < 0 ? providerOrder.length : rightIndex)
    );
  });
  const disabled = (entry: ProviderCatalogEntry) =>
    !entry.available || Boolean(isProviderDisabled?.(entry));
  const selectedProvider = providers.find(({ key }) => key === provider);
  const selectedModel = selectedProvider?.models.find(({ id }) => id === model);
  const selection: ModelPreset | null = selectedModel
    ? { provider, model, effort }
    : null;
  const efforts = selectedModel?.efforts.length
    ? selectedModel.efforts
    : ["auto"];

  /**
   * A preset outlives the catalog that produced it: agents go offline and
   * providers drop models between syncs, so anything that no longer resolves
   * to a usable model is left out rather than offered and then rejected.
   */
  const resolve = (presets: ModelPreset[]) =>
    presets.flatMap((preset) => {
      const entry = providers.find(({ key }) => key === preset.provider);
      const found = entry?.models.find(({ id }) => id === preset.model);
      if (!entry || !found || disabled(entry)) return [];
      return [{ preset, entry, model: found }];
    });
  const railPresets = resolve(rail).filter(
    ({ preset }) => !selection || !sameModelPreset(preset, selection),
  );
  const pinnedPresets = resolve(pinned);

  const apply = (preset: ModelPreset) => {
    if (preset.provider !== provider) onProviderChange(preset.provider);
    onModelChange(preset.model);
    onEffortChange(preset.effort);
    remember(preset);
  };
  /** Effort carries across a model switch when the target supports it. */
  const carriedEffort = (next: CatalogModel) =>
    next.efforts.includes(effort)
      ? effort
      : next.efforts.includes("auto")
        ? "auto"
        : (next.efforts[0] ?? "auto");
  const choose = (preset: ModelPreset) => {
    apply(preset);
    setOpen(false);
  };
  const chooseEffort = (value: string) => {
    onEffortChange(value);
    if (selection) remember({ ...selection, effort: value });
  };

  return (
    <div className="space-y-2">
      <Label>{t("modelEffort")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger asChild>
            <Button className="h-8 font-normal" type="button" variant="outline">
              {selectedProvider && selectedModel ? (
                <>
                  <ProviderIcon provider={selectedProvider.key} />
                  <span className="max-w-48 truncate">
                    {formatModelLabel(selectedModel.label)}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <EffortIcon effort={effort} efforts={selectedModel.efforts} />
                  <span className="text-muted-foreground">{effort}</span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {t("chooseModel")}
                </span>
              )}
              <ChevronsUpDown className="text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(32rem,calc(100vw-2rem))] p-0"
          >
            <Command>
              <CommandInput
                placeholder={t("search", { kind: t("model").toLowerCase() })}
              />
              <CommandList>
                <CommandEmpty>{t("empty", { kind: t("model") })}</CommandEmpty>
                {pinnedPresets.length > 0 && (
                  <CommandGroup heading={t("presets")}>
                    {pinnedPresets.map(({ preset, entry, model: preseted }) => (
                      <CommandItem
                        className={checkedRow}
                        data-checked={Boolean(
                          selection && sameModelPreset(preset, selection),
                        )}
                        key={modelPresetKey(preset)}
                        onSelect={() => choose(preset)}
                        value={`${entry.label} ${preseted.label} ${preseted.id} ${preset.effort}`}
                      >
                        <ProviderIcon provider={entry.key} />
                        <span className="min-w-0 flex-1 truncate">
                          {formatModelLabel(preseted.label)}
                        </span>
                        <span
                          className="flex items-center gap-1.5 text-muted-foreground"
                          data-slot="command-shortcut"
                        >
                          <EffortIcon
                            effort={preset.effort}
                            efforts={preseted.efforts}
                          />
                          <span className="text-xs">{preset.effort}</span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                {providers.map((entry) => (
                  <CommandGroup heading={entry.label} key={entry.key}>
                    {entry.models.map((entryModel) => {
                      const current =
                        entry.key === provider && entryModel.id === model;
                      const modelEfforts = entryModel.efforts.length
                        ? entryModel.efforts
                        : ["auto"];
                      return (
                        <CommandItem
                          className={checkedRow}
                          data-checked={current}
                          disabled={disabled(entry)}
                          key={`${entry.key}/${entryModel.id}`}
                          onSelect={() =>
                            choose({
                              provider: entry.key,
                              model: entryModel.id,
                              effort: carriedEffort(entryModel),
                            })
                          }
                          value={`${entry.label} ${entryModel.label} ${entryModel.id}`}
                        >
                          <ProviderIcon provider={entry.key} />
                          <span className="min-w-0 flex-1 truncate">
                            {formatModelLabel(entryModel.label)}
                          </span>
                          {/*
                           * A pointer can set model and effort in one click, so
                           * the strip rides the row's hover/keyboard highlight.
                           * It stays in the layout while hidden to keep labels
                           * from reflowing row to row, shows unconditionally
                           * where there is no hover to reveal it, and is hidden
                           * from assistive tech in favour of the footer strip —
                           * which is the keyboard and screen-reader path.
                           */}
                          <span
                            aria-hidden="true"
                            className="invisible flex items-center gap-0.5 group-data-[selected=true]/command-item:visible pointer-coarse:visible"
                            data-slot="command-shortcut"
                          >
                            {modelEfforts.map((value) => (
                              <button
                                className={cn(
                                  "rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground",
                                  current &&
                                    effort === value &&
                                    "bg-background text-foreground",
                                )}
                                key={value}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  choose({
                                    provider: entry.key,
                                    model: entryModel.id,
                                    effort: value,
                                  });
                                }}
                                onPointerDown={(event) =>
                                  event.stopPropagation()
                                }
                                tabIndex={-1}
                                title={value}
                                type="button"
                              >
                                <EffortIcon
                                  effort={value}
                                  efforts={modelEfforts}
                                />
                              </button>
                            ))}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
            <div className="flex items-center gap-2 border-t p-2">
              <span className="text-xs text-muted-foreground">
                {t("effort")}
              </span>
              <TooltipProvider>
                <div className="flex items-center gap-0.5">
                  {efforts.map((value) => (
                    <Tooltip key={value}>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label={`${t("effort")}: ${value}`}
                          disabled={!selectedModel}
                          onClick={() => chooseEffort(value)}
                          size="icon-xs"
                          type="button"
                          variant={effort === value ? "secondary" : "ghost"}
                        >
                          <EffortIcon effort={value} efforts={efforts} />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{value}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label={
                        selection && isPinned(selection)
                          ? t("unpinPreset")
                          : t("pinPreset")
                      }
                      className="ml-auto"
                      disabled={!selection}
                      onClick={() => selection && togglePin(selection)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      {selection && isPinned(selection) ? <PinOff /> : <Pin />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {selection && isPinned(selection)
                      ? t("unpinPreset")
                      : t("pinPreset")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </PopoverContent>
        </Popover>
        {railPresets
          .slice(0, modelPresetRailLimit)
          .map(({ preset, entry, model: presetModel }) => (
            <Button
              className="h-8 font-normal"
              key={modelPresetKey(preset)}
              onClick={() => apply(preset)}
              type="button"
              variant="ghost"
            >
              <ProviderIcon provider={entry.key} />
              <span className="max-w-32 truncate">
                {formatModelLabel(presetModel.label)}
              </span>
              <EffortIcon
                className="text-muted-foreground"
                effort={preset.effort}
                efforts={presetModel.efforts}
              />
            </Button>
          ))}
      </div>
    </div>
  );
}
