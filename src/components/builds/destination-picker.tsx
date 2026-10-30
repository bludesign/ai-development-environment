"use client";

import {
  CheckSquare2,
  ChevronDown,
  Circle,
  CircleDot,
  Search,
  Square,
} from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { buildDestinationState } from "./build-format";
import type { BuildDestination } from "./types";

type Translate = Parameters<typeof buildDestinationState>[1];
export function destinationName(destination: BuildDestination) {
  return destination.type === "SIMULATOR" &&
    destination.deviceType &&
    destination.deviceType !== destination.name
    ? `${destination.name} · ${destination.deviceType}`
    : destination.name;
}
export function filterDestinations(
  destinations: BuildDestination[],
  search: string,
  translate: Translate,
) {
  const query = search.trim().toLocaleLowerCase();
  return destinations.filter(
    (destination) =>
      !query ||
      [
        destination.name,
        destination.deviceType,
        destination.platform,
        destination.osVersion,
        destination.state,
        buildDestinationState(destination, translate),
      ].some((value) => value?.toLocaleLowerCase().includes(query)),
  );
}
function DestinationLabel({ destination }: { destination: BuildDestination }) {
  const t = useTranslations("builds");
  const name = destination.generic
    ? t(destination.type === "SIMULATOR" ? "anySimulator" : "anyPhysicalDevice")
    : destinationName(destination);
  const detail = [destination.platform, destination.osVersion]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{name}</span>
      {!destination.generic && (
        <span className="block truncate text-xs text-muted-foreground">
          {detail ? `${detail} · ` : ""}
          {buildDestinationState(destination, t)}
        </span>
      )}
    </span>
  );
}
export function DestinationRow({
  destination,
  selected,
  disabled,
  onSelect,
  multiple = false,
}: {
  destination: BuildDestination;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  multiple?: boolean;
}) {
  const Icon = multiple
    ? selected
      ? CheckSquare2
      : Square
    : selected
      ? CircleDot
      : Circle;
  return (
    <button
      aria-checked={selected}
      role={multiple ? "menuitemcheckbox" : "option"}
      aria-selected={multiple ? undefined : selected}
      aria-disabled={disabled}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <Icon className="size-4 shrink-0" />
      <DestinationLabel destination={destination} />
    </button>
  );
}
export function DestinationSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("builds");
  return (
    <div className="relative p-1.5">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label={t("searchDevices")}
        className="h-7 pl-7 text-xs"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder={t("searchDevices")}
        type="search"
        value={value}
      />
    </div>
  );
}
export function BuildDestinationPicker({
  id,
  destinations,
  value,
  loading,
  onChange,
}: {
  id: string;
  destinations: BuildDestination[];
  value: string;
  loading: boolean;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("builds");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = destinations.find((destination) => destination.id === value);
  const filtered = filterDestinations(destinations, search, t);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setSearch("");
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-busy={loading}
          disabled={!destinations.length}
          variant="outline"
          className="h-auto min-h-9 w-full justify-between text-left"
        >
          {selected ? (
            <DestinationLabel destination={selected} />
          ) : (
            t("selectDevice")
          )}
          <ChevronDown className="size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        role="listbox"
        align="start"
        className="w-[min(26rem,calc(100vw-2rem))]"
      >
        <DestinationSearch value={search} onChange={setSearch} />
        <div className="max-h-72 overflow-y-auto">
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              onChange(next);
              setOpen(false);
              setSearch("");
            }}
          >
            {filtered.map((destination) => (
              <DropdownMenuRadioItem
                role="option"
                aria-selected={destination.id === value}
                key={destination.id}
                value={destination.id}
                disabled={destination.available === false}
                className="py-1.5"
              >
                <DestinationLabel destination={destination} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {!filtered.length && (
            <p className="p-3 text-xs text-muted-foreground">
              {t("noDevicesMatchSearch")}
            </p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
