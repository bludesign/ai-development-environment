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
  const { rail, isPinned, togglePin, remember } = useModelPresets();
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
  const resolved = rail.flatMap((preset) => {
    const entry = providers.find(({ key }) => key === preset.provider);
    const found = entry?.models.find(({ id }) => id === preset.model);
    if (!entry || !found || disabled(entry)) return [];
    if (selection && sameModelPreset(preset, selection)) return [];
    return [{ preset, entry, model: found }];
  });

  const apply = (preset: ModelPreset) => {
    if (preset.provider !== provider) onProviderChange(preset.provider);
    onModelChange(preset.model);
    onEffortChange(preset.effort);
    remember(preset);
  };
  /** Effort carries across a model switch when the target supports it. */
  const chooseModel = (entry: ProviderCatalogEntry, next: CatalogModel) => {
    apply({
      provider: entry.key,
      model: next.id,
      effort: next.efforts.includes(effort)
        ? effort
        : next.efforts.includes("auto")
          ? "auto"
          : (next.efforts[0] ?? "auto"),
    });
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
                  <EffortIcon effort={effort} />
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
          <PopoverContent align="start" className="w-80 p-0">
            <Command>
              <CommandInput
                placeholder={t("search", { kind: t("model").toLowerCase() })}
              />
              <CommandList>
                <CommandEmpty>{t("empty", { kind: t("model") })}</CommandEmpty>
                {providers.map((entry) => (
                  <CommandGroup heading={entry.label} key={entry.key}>
                    {entry.models.map((entryModel) => (
                      <CommandItem
                        data-checked={
                          entry.key === provider && entryModel.id === model
                        }
                        disabled={disabled(entry)}
                        key={`${entry.key}/${entryModel.id}`}
                        onSelect={() => chooseModel(entry, entryModel)}
                        value={`${entry.label} ${entryModel.label} ${entryModel.id}`}
                      >
                        <ProviderIcon provider={entry.key} />
                        <span className="min-w-0 flex-1 truncate">
                          {formatModelLabel(entryModel.label)}
                        </span>
                      </CommandItem>
                    ))}
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
                          <EffortIcon effort={value} />
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
        {resolved
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
              />
            </Button>
          ))}
      </div>
    </div>
  );
}
