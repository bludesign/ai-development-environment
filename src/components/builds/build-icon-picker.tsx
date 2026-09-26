"use client";

import { useTranslations } from "next-intl";
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
        {["none", ...BUILD_CONFIGURATION_ICON_KEYS]
          .filter((value, index, all) => all.indexOf(value) === index)
          .map((key) => (
            <SelectItem key={key} value={key}>
              <ConfigurationIcon iconKey={key} />
              {t(`configurationIcons.${key}`)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
