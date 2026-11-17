import { useId } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function parseCommandPort(value: string): number | null | undefined {
  const digits = value.trim();
  if (!digits) return null;
  const port = Number(digits);
  return /^\d+$/.test(digits) && port >= 1 && port <= 65_535 ? port : undefined;
}

export function CommandPortField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations("commands");
  const id = useId();
  const invalid = parseCommandPort(value) === undefined;

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{t("optionalPort")}</Label>
      <Input
        aria-describedby={`${id}-description`}
        aria-invalid={invalid}
        className="max-w-32"
        id={id}
        inputMode="numeric"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
      <p
        className={
          invalid ? "text-xs text-destructive" : "text-xs text-muted-foreground"
        }
        id={`${id}-description`}
      >
        {t(invalid ? "portInvalid" : "portHelp")}
      </p>
    </div>
  );
}
