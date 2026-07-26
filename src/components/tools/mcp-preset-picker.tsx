"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { ConfigurationIcon } from "@/components/builds/configuration-icon";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

export type McpToolPresetView = {
  id: string;
  name: string;
  description: string;
  iconKey: string;
  enabledForPlans: boolean;
  enabledForSessions: boolean;
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
};

export const MCP_PRESET_FIELDS =
  "id name description iconKey enabledForPlans enabledForSessions toolNames createdAt updatedAt";

export async function loadMcpToolPresets(
  kind?: "PLAN" | "SESSION" | null,
): Promise<McpToolPresetView[]> {
  const data = await controlPlaneRequest<{
    mcpToolPresets: McpToolPresetView[];
  }>(
    `query McpToolPresets($kind: RunKind) {
      mcpToolPresets(kind: $kind) { ${MCP_PRESET_FIELDS} }
    }`,
    { kind: kind ?? null },
  );
  return data.mcpToolPresets ?? [];
}

export function McpPresetPicker({
  kind,
  selectedIds,
  onChange,
  disabled = false,
  showAvailability = kind == null,
  className,
}: {
  kind?: "PLAN" | "SESSION" | null;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  showAvailability?: boolean;
  className?: string;
}) {
  const t = useTranslations("mcpPresets");
  const [presets, setPresets] = useState<McpToolPresetView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void loadMcpToolPresets(kind)
        .then((next) => {
          if (!cancelled) {
            setPresets(next);
            setError(null);
          }
        })
        .catch((value) => {
          if (!cancelled)
            setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kind]);

  if (loading && !presets.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> {t("loading")}
      </p>
    );
  }
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!presets.length) {
    return (
      <p className="text-sm text-muted-foreground">{t("noneAvailable")}</p>
    );
  }

  const selected = new Set(selectedIds);
  return (
    <div className={cn("grid gap-2 md:grid-cols-2", className)}>
      {presets.map((preset) => (
        <label
          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-disabled:cursor-not-allowed has-aria-checked:border-primary/50"
          key={preset.id}
        >
          <Checkbox
            checked={selected.has(preset.id)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...selectedIds, preset.id]
                  : selectedIds.filter((id) => id !== preset.id),
              )
            }
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 font-medium">
              <ConfigurationIcon iconKey={preset.iconKey} />
              <span className="truncate">{preset.name}</span>
            </span>
            {preset.description && (
              <span className="mt-1 block text-xs text-muted-foreground">
                {preset.description}
              </span>
            )}
            {showAvailability && (
              <span className="mt-2 flex flex-wrap gap-1">
                {preset.enabledForPlans && (
                  <Badge variant="outline">{t("plans")}</Badge>
                )}
                {preset.enabledForSessions && (
                  <Badge variant="outline">{t("sessions")}</Badge>
                )}
                {!preset.enabledForPlans && !preset.enabledForSessions && (
                  <Badge variant="secondary">{t("directOnly")}</Badge>
                )}
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
