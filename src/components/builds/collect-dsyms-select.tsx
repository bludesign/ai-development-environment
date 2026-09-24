"use client";

import { useTranslations } from "next-intl";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MODES = ["AUTOMATIC", "ON", "OFF"] as const;
type Mode = (typeof MODES)[number];

function mode(value: unknown): Mode {
  if (value === true) return "ON";
  if (value === false) return "OFF";
  return "AUTOMATIC";
}

/**
 * The `collectDsyms` build setting: automatic keeps the dSYMs of archives only,
 * which are the builds that reach devices and crash.
 */
export function CollectDsymsSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: unknown;
  onChange: (value: boolean | null) => void;
}) {
  const t = useTranslations("builds");
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("collectDsyms")}</Label>
      <Select
        onValueChange={(next) =>
          onChange(next === "ON" ? true : next === "OFF" ? false : null)
        }
        value={mode(value)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODES.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {t(`collectDsymsModes.${entry}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {t("collectDsymsDescription")}
      </p>
    </div>
  );
}
