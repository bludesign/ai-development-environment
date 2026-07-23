"use client";

import { useState, useSyncExternalStore } from "react";
import {
  Bot,
  ChevronDown,
  Code2,
  Feather,
  Flame,
  Gauge,
  Rocket,
  Sparkles,
  Star,
  Terminal,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ProviderCatalogEntry = {
  key: string;
  label: string;
  available: boolean;
  supportsWebSearch: boolean;
  models: Array<{ id: string; label: string; efforts: string[] }>;
};

const providerOrder = ["CODEX", "CLAUDE", "OPENCODE"];
const favoriteStorageKey = "aide.favorite-models.v1";
const favoriteChangeEvent = "aide:model-favorites";

function favoriteSnapshot() {
  if (typeof window === "undefined") return "{}";
  try {
    return window.localStorage.getItem(favoriteStorageKey) ?? "{}";
  } catch {
    return "{}";
  }
}

function subscribeToFavorites(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(favoriteChangeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(favoriteChangeEvent, onChange);
  };
}

function parseFavorites(value: string): Record<string, string[]> {
  try {
    return JSON.parse(value) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function ProviderIcon({ provider }: { provider: string }) {
  const Icon =
    provider === "CODEX" ? Bot : provider === "CLAUDE" ? Sparkles : Terminal;
  return <Icon aria-hidden="true" />;
}

function EffortIcon({ effort }: { effort: string }) {
  const value = effort.toLowerCase();
  const Icon =
    value === "low"
      ? Feather
      : value === "medium"
        ? Gauge
        : value === "high"
          ? Zap
          : value === "xhigh"
            ? Flame
            : value === "max" || value === "ultra"
              ? Rocket
              : Sparkles;
  return <Icon aria-hidden="true" />;
}

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
  const favoriteValue = useSyncExternalStore(
    subscribeToFavorites,
    favoriteSnapshot,
    () => "{}",
  );
  const favorites = parseFavorites(favoriteValue);
  const [moreOpen, setMoreOpen] = useState(false);

  const providers = [...catalog].sort((left, right) => {
    const leftIndex = providerOrder.indexOf(left.key);
    const rightIndex = providerOrder.indexOf(right.key);
    return (
      (leftIndex < 0 ? providerOrder.length : leftIndex) -
      (rightIndex < 0 ? providerOrder.length : rightIndex)
    );
  });
  const selectedProvider = providers.find(({ key }) => key === provider);
  const selectedModel = selectedProvider?.models.find(({ id }) => id === model);
  const providerFavorites = favorites[provider] ?? [];
  const models = [...(selectedProvider?.models ?? [])].sort((left, right) => {
    const leftIndex = providerFavorites.indexOf(left.id);
    const rightIndex = providerFavorites.indexOf(right.id);
    if (leftIndex >= 0 || rightIndex >= 0) {
      if (leftIndex < 0) return 1;
      if (rightIndex < 0) return -1;
      return leftIndex - rightIndex;
    }
    return 0;
  });

  const chooseModel = (value: string) => {
    const entry = selectedProvider?.models.find(({ id }) => id === value);
    onModelChange(value);
    onEffortChange(
      entry?.efforts.includes("auto") ? "auto" : (entry?.efforts[0] ?? "auto"),
    );
    setMoreOpen(false);
  };
  const toggleFavorite = (value: string) => {
    const current = new Set(favorites[provider] ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const next = { ...favorites, [provider]: [...current] };
    try {
      window.localStorage.setItem(favoriteStorageKey, JSON.stringify(next));
      window.dispatchEvent(new Event(favoriteChangeEvent));
    } catch {
      // A private browsing policy may make local storage unavailable.
    }
  };
  const disabled = (entry: ProviderCatalogEntry) =>
    !entry.available || Boolean(isProviderDisabled?.(entry));

  if (!selectedProvider) {
    return (
      <div className="space-y-2">
        <Label>{t("tool")}</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {providers.slice(0, 3).map((entry) => (
            <Button
              className="h-11 justify-start"
              disabled={disabled(entry)}
              key={entry.key}
              onClick={() => onProviderChange(entry.key)}
              type="button"
              variant="outline"
            >
              <ProviderIcon provider={entry.key} />
              {entry.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  if (!selectedModel) {
    return (
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="w-40 space-y-1.5">
            <Label>{t("tool")}</Label>
            <Select
              onValueChange={(value) => onProviderChange(value ?? "")}
              value={provider}
            >
              <SelectTrigger className="h-8">
                <ProviderIcon provider={provider} />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((entry) => (
                  <SelectItem
                    disabled={disabled(entry)}
                    key={entry.key}
                    value={entry.key}
                  >
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="pb-1 text-sm text-muted-foreground">{t("model")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {models.slice(0, 3).map((entry) => (
            <Button
              key={entry.id}
              onClick={() => chooseModel(entry.id)}
              type="button"
              variant="outline"
            >
              <Code2 /> {entry.label}
              {providerFavorites.includes(entry.id) && (
                <Star className="fill-current" />
              )}
            </Button>
          ))}
          {models.length > 3 && (
            <Popover onOpenChange={setMoreOpen} open={moreOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost">
                  More <ChevronDown />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-0">
                <Command>
                  <CommandInput
                    placeholder={t("search", {
                      kind: t("model").toLowerCase(),
                    })}
                  />
                  <CommandList>
                    <CommandEmpty>
                      {t("empty", { kind: t("model") })}
                    </CommandEmpty>
                    {models.map((entry) => {
                      const favorite = providerFavorites.includes(entry.id);
                      return (
                        <CommandItem
                          key={entry.id}
                          onSelect={() => chooseModel(entry.id)}
                          value={`${entry.label} ${entry.id}`}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {entry.label}
                          </span>
                          <button
                            aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${entry.label}`}
                            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleFavorite(entry.id);
                            }}
                            type="button"
                          >
                            <Star className={cn(favorite && "fill-current")} />
                          </button>
                        </CommandItem>
                      );
                    })}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
    );
  }

  const efforts = selectedModel.efforts.length
    ? selectedModel.efforts
    : ["auto"];
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="w-36 space-y-1.5">
        <Label>{t("tool")}</Label>
        <Select
          onValueChange={(value) => onProviderChange(value ?? "")}
          value={provider}
        >
          <SelectTrigger className="h-8">
            <ProviderIcon provider={provider} />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((entry) => (
              <SelectItem
                disabled={disabled(entry)}
                key={entry.key}
                value={entry.key}
              >
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-44 flex-1 space-y-1.5">
        <Label>{t("model")}</Label>
        <Select
          onValueChange={(value) => chooseModel(value ?? "")}
          value={model}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{t("effort")}</Label>
        <TooltipProvider>
          <div className="flex h-8 items-center rounded-lg border bg-background p-0.5">
            {efforts.map((value) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={`${t("effort")}: ${value}`}
                    className="size-6"
                    onClick={() => onEffortChange(value)}
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
        </TooltipProvider>
      </div>
    </div>
  );
}
