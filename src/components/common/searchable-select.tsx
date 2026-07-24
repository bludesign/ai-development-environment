"use client";

import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type SearchableSelectOption = {
  value: string;
  label: string;
  description?: string;
  secondaryDescription?: string;
  keywords?: string;
  disabled?: boolean;
};

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyMessage,
  ariaLabel,
  disabled,
  className,
  showSelectedDetails = false,
  allowCustomValue = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  showSelectedDetails?: boolean;
  allowCustomValue?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value);
  const displayValue = selected?.label ?? (value || placeholder);
  const customValue = query.trim();
  const showCustomValue =
    allowCustomValue &&
    customValue.length > 0 &&
    !options.some(
      (option) =>
        option.value.toLowerCase() === customValue.toLowerCase() ||
        option.label.toLowerCase() === customValue.toLowerCase(),
    );

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            "min-w-0 w-full justify-between font-normal",
            showSelectedDetails && selected && "h-auto min-h-8 py-2",
            className,
          )}
          disabled={disabled}
          role="combobox"
          type="button"
          variant="outline"
        >
          {showSelectedDetails && selected ? (
            <span className="min-w-0 text-left">
              <span className="block truncate">{selected.label}</span>
              {selected.description && (
                <span className="block truncate text-xs text-muted-foreground">
                  {selected.description}
                </span>
              )}
              {selected.secondaryDescription && (
                <span className="block truncate text-xs text-muted-foreground">
                  {selected.secondaryDescription}
                </span>
              )}
            </span>
          ) : (
            <span className="min-w-0 truncate">{displayValue}</span>
          )}
          <ChevronsUpDown className="shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-70 max-h-[min(24rem,var(--radix-popover-content-available-height))] w-(--radix-popover-trigger-width) overflow-hidden p-0"
      >
        <Command label={searchPlaceholder}>
          <CommandInput
            aria-label={searchPlaceholder}
            autoFocus
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
            value={query}
          />
          <CommandList className="max-h-64 overscroll-contain [scrollbar-width:thin] [&::-webkit-scrollbar]:block [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {showCustomValue && (
                <CommandItem
                  aria-label={customValue}
                  onSelect={() => {
                    onValueChange(customValue);
                    setQuery("");
                    setOpen(false);
                  }}
                  value={customValue}
                >
                  <Item className="min-w-0 flex-1 border-0 p-0" size="xs">
                    <ItemContent className="min-w-0">
                      <ItemTitle className="block truncate">
                        {customValue}
                      </ItemTitle>
                    </ItemContent>
                  </Item>
                </CommandItem>
              )}
              {options.map((option) => (
                <CommandItem
                  aria-label={[
                    option.label,
                    option.description,
                    option.secondaryDescription,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  aria-selected={option.value === value}
                  className="items-start py-2"
                  data-checked={option.value === value}
                  disabled={option.disabled}
                  key={option.value}
                  keywords={[
                    option.label,
                    option.description ?? "",
                    option.secondaryDescription ?? "",
                    option.keywords ?? "",
                  ]}
                  onSelect={() => {
                    onValueChange(option.value);
                    setQuery("");
                    setOpen(false);
                  }}
                  value={option.value}
                >
                  <Item className="min-w-0 flex-1 border-0 p-0" size="xs">
                    <ItemContent className="min-w-0">
                      <ItemTitle className="block truncate">
                        {option.label}
                      </ItemTitle>
                      {option.description && (
                        <ItemDescription className="block truncate">
                          {option.description}
                        </ItemDescription>
                      )}
                      {option.secondaryDescription && (
                        <ItemDescription className="block truncate">
                          {option.secondaryDescription}
                        </ItemDescription>
                      )}
                    </ItemContent>
                  </Item>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
