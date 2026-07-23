"use client";

import { useEffect, useRef, useState } from "react";
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
 * Geometry of one effort chip, shared by the real strip and by the sizer that
 * stands in for it. Keep in step with the chip's `p-0.5` around a `w-5` icon
 * and the strip's `gap-0.5`.
 */
const effortChipWidth = 24;
const effortChipGap = 2;

function effortStripWidth(count: number) {
  return count * effortChipWidth + Math.max(count - 1, 0) * effortChipGap;
}

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
 * The rail is a convenience beside the pill, so it yields space rather than
 * claiming it: chips drop from the end until what is left fits on one line,
 * and the pill — which is the control proper — always survives.
 *
 * Chip widths track model names, so a breakpoint guess would have to assume
 * the longest name and would then waste most of the row on `Opus`. Measuring
 * what is actually rendered fills the width instead. Chips that do not fit are
 * hidden with `invisible` rather than unmounted, which keeps their widths
 * measurable on the next resize and stops the count from oscillating: hiding a
 * chip changes no geometry, so the observer cannot feed itself.
 */
function useRailFit(signature: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const measure = () => {
      const [pill, ...chips] = [...container.children] as HTMLElement[];
      if (!pill) return;
      const gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
      let used = pill.offsetWidth;
      let fits = 0;
      for (const chip of chips) {
        const next = used + gap + chip.offsetWidth;
        if (next > container.clientWidth) break;
        used = next;
        fits += 1;
      }
      setVisible(fits);
    };
    /*
     * The observer catches the container changing without the window doing so
     * — the navigation and notification panels both collapse beside this form.
     * The window listener is the coarse backstop for the ordinary case, and
     * keeps the rail correct wherever observer delivery is throttled. Neither
     * is load-bearing for a first render, and jsdom ships no ResizeObserver at
     * all, so the observer is optional rather than a hard dependency.
     */
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(container);
    if (observer) {
      for (const child of container.children) observer.observe(child);
    }
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [signature]);
  return { railRef: ref, visible };
}

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

  const shown = railPresets.slice(0, modelPresetRailLimit);
  const { railRef, visible } = useRailFit(
    [
      selection && modelPresetKey(selection),
      ...shown.map(({ preset }) => modelPresetKey(preset)),
    ].join("|"),
  );

  return (
    <div className="space-y-2">
      <Label>{t("modelEffort")}</Label>
      <div className="flex items-center gap-2 overflow-hidden" ref={railRef}>
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger asChild>
            {/*
             * Hidden chips keep their layout box so they stay measurable, so
             * the row overflows by design. Nothing may shrink to absorb that —
             * a shrinking pill would both look collapsed and feed a bogus width
             * back into the measurement. `max-w-full` still caps the pill to
             * the container on a narrow screen, where its label truncates and
             * the measurement correctly concludes that no chip fits.
             */}
            <Button
              className="h-8 min-w-0 max-w-full shrink-0 font-normal"
              type="button"
              variant="outline"
            >
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
            className="w-max max-w-[min(32rem,calc(100vw-2rem))] p-0"
          >
            {/*
             * `w-max` alone would resize the popover on every keystroke, since
             * filtering changes which row is widest. This stands in for the
             * unfiltered list — one zero-height replica per row, carrying the
             * label and a spacer the width of that model's effort strip — so
             * the popover settles on the width the whole catalog needs and then
             * holds it. `max-w` caps it to the viewport, past which the labels
             * truncate. `px-4` is the row's inherited padding: `p-1` on the
             * command, `p-1` on the group, `px-2` on the item.
             */}
            <div aria-hidden="true" className="h-0 overflow-hidden">
              {providers.flatMap((entry) =>
                entry.models.map((entryModel) => (
                  <div
                    className="flex items-center gap-2 px-4 text-sm whitespace-nowrap"
                    key={`${entry.key}/${entryModel.id}`}
                  >
                    <span className="size-4" />
                    <span>{formatModelLabel(entryModel.label)}</span>
                    <span
                      style={{
                        width: effortStripWidth(
                          Math.max(entryModel.efforts.length, 1),
                        ),
                      }}
                    />
                  </div>
                )),
              )}
            </div>
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
        {shown.map(({ preset, entry, model: presetModel }, index) => {
          const fits = index < visible;
          return (
            <Button
              aria-hidden={!fits}
              className={cn("h-8 shrink-0 font-normal", !fits && "invisible")}
              key={modelPresetKey(preset)}
              onClick={() => apply(preset)}
              tabIndex={fits ? undefined : -1}
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
          );
        })}
      </div>
    </div>
  );
}
