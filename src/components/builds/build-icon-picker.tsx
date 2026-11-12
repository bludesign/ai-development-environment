"use client";

import { ChevronDown, CircleOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BUILD_CONFIGURATION_ICON_KEYS,
  ConfigurationIcon,
} from "./configuration-icon";

const iconOptions = ["none", ...BUILD_CONFIGURATION_ICON_KEYS];

export function BuildConfigurationIconPicker({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("builds");
  const selection = value ?? "none";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${t("icon")}: ${t(`configurationIcons.${selection}`)}`}
          className="justify-between"
          disabled={disabled}
          id={id}
          type="button"
          variant="outline"
        >
          <span className="flex min-w-0 items-center gap-2">
            {value ? (
              <ConfigurationIcon iconKey={value} />
            ) : (
              <CircleOff className="size-4 shrink-0" />
            )}
            <span className="truncate">
              {t(`configurationIcons.${selection}`)}
            </span>
          </span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          onValueChange={(key) => onChange(key === "none" ? null : key)}
          value={selection}
        >
          {iconOptions.map((key) => (
            <DropdownMenuRadioItem key={key} value={key}>
              {key === "none" ? (
                <CircleOff className="size-4" />
              ) : (
                <ConfigurationIcon iconKey={key} />
              )}
              {t(`configurationIcons.${key}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BuildIconPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const t = useTranslations("builds");
  return (
    <Select
      value={value ?? "none"}
      onValueChange={(value) => onChange(value === "none" ? null : value)}
    >
      <SelectTrigger aria-label={t("icon")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {iconOptions.map((key) => (
          <SelectItem key={key} value={key}>
            <ConfigurationIcon iconKey={key} />
            {t(`configurationIcons.${key}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
