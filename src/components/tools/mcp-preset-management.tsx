"use client";

import { Check, Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  BUILD_CONFIGURATION_ICON_KEYS,
  ConfigurationIcon,
} from "@/components/builds/configuration-icon";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { copyText } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { ToolCatalogGroup } from "@/services/tools/types";

import {
  MCP_PRESET_FIELDS,
  loadMcpToolPresets,
  type McpToolPresetView,
} from "./mcp-preset-picker";

type PresetDraft = {
  name: string;
  description: string;
  iconKey: string;
  enabledForPlans: boolean;
  enabledForSessions: boolean;
  toolNames: string[];
};

const emptyDraft = (): PresetDraft => ({
  name: "",
  description: "",
  iconKey: "wrench",
  enabledForPlans: false,
  enabledForSessions: false,
  toolNames: [],
});

function draftFromPreset(preset: McpToolPresetView): PresetDraft {
  return {
    name: preset.name,
    description: preset.description,
    iconKey: preset.iconKey,
    enabledForPlans: preset.enabledForPlans,
    enabledForSessions: preset.enabledForSessions,
    toolNames: [...preset.toolNames],
  };
}

export function descendantToolNames(group: ToolCatalogGroup): string[] {
  return [
    ...(group.tools ?? []).map(({ name }) => name),
    ...(group.children ?? []).flatMap(descendantToolNames),
  ];
}

export function groupCheckboxState(
  names: string[],
  selected: ReadonlySet<string>,
): boolean | "indeterminate" {
  const selectedCount = names.filter((name) => selected.has(name)).length;
  return selectedCount === 0
    ? false
    : selectedCount === names.length
      ? true
      : "indeterminate";
}

function filterGroup(
  group: ToolCatalogGroup,
  needle: string,
): ToolCatalogGroup | null {
  if (!needle) return group;
  const tools = (group.tools ?? []).filter((tool) =>
    [tool.name, tool.title, tool.description]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(needle)),
  );
  const children = (group.children ?? []).flatMap((child) => {
    const filtered = filterGroup(child, needle);
    return filtered ? [filtered] : [];
  });
  return group.name.toLocaleLowerCase().includes(needle) ||
    tools.length ||
    children.length
    ? { ...group, tools, children }
    : null;
}

function ToolGroupPicker({
  group,
  allNames,
  selected,
  onToggle,
  depth = 0,
}: {
  group: ToolCatalogGroup;
  allNames: Map<string, string[]>;
  selected: Set<string>;
  onToggle: (names: string[], checked: boolean) => void;
  depth?: number;
}) {
  const names = allNames.get(group.id) ?? descendantToolNames(group);
  const checked = groupCheckboxState(names, selected);
  return (
    <div className={depth ? "ml-5 border-l pl-3" : ""}>
      <label className="flex items-center gap-2 py-2 font-medium">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onToggle(names, Boolean(value))}
        />
        {group.name}
      </label>
      <div className="grid gap-1 sm:grid-cols-2">
        {(group.tools ?? []).map((tool) => (
          <label
            className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            key={tool.name}
          >
            <Checkbox
              checked={selected.has(tool.name)}
              onCheckedChange={(value) => onToggle([tool.name], Boolean(value))}
            />
            <span className="min-w-0">
              <span className="block truncate">{tool.title || tool.name}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {tool.name}
              </span>
            </span>
          </label>
        ))}
      </div>
      {(group.children ?? []).map((child) => (
        <ToolGroupPicker
          allNames={allNames}
          depth={depth + 1}
          group={child}
          key={child.id}
          onToggle={onToggle}
          selected={selected}
        />
      ))}
    </div>
  );
}

export function McpPresetManagement({
  groups,
  baseMcpUrl,
}: {
  groups: ToolCatalogGroup[];
  baseMcpUrl: string;
}) {
  const t = useTranslations("mcpPresets");
  const tc = useTranslations("common");
  const [presets, setPresets] = useState<McpToolPresetView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpToolPresetView | null>(null);
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPresets(await loadMcpToolPresets(null));
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const builtInGroups = useMemo(
    () => groups.filter(({ source }) => source === "BUILTIN"),
    [groups],
  );
  const allNames = useMemo(() => {
    const map = new Map<string, string[]>();
    const visit = (group: ToolCatalogGroup) => {
      map.set(group.id, descendantToolNames(group));
      (group.children ?? []).forEach(visit);
    };
    builtInGroups.forEach(visit);
    return map;
  }, [builtInGroups]);
  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return builtInGroups.flatMap((group) => {
      const filtered = filterGroup(group, needle);
      return filtered ? [filtered] : [];
    });
  }, [builtInGroups, search]);

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft());
    setSearch("");
    setDialogError(null);
    setDialogOpen(true);
  };
  const openEdit = (preset: McpToolPresetView) => {
    setEditing(preset);
    setDraft(draftFromPreset(preset));
    setSearch("");
    setDialogError(null);
    setDialogOpen(true);
  };
  const toggleTools = (names: string[], checked: boolean) => {
    const next = new Set(draft.toolNames);
    for (const name of names) {
      if (checked) next.add(name);
      else next.delete(name);
    }
    setDraft({ ...draft, toolNames: [...next] });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editing) {
        await controlPlaneRequest(
          `mutation UpdateMcpToolPreset($id: ID!, $input: McpToolPresetInput!) {
            updateMcpToolPreset(id: $id, input: $input) { ${MCP_PRESET_FIELDS} }
          }`,
          { id: editing.id, input: draft },
        );
      } else {
        await controlPlaneRequest(
          `mutation CreateMcpToolPreset($input: McpToolPresetInput!) {
            createMcpToolPreset(input: $input) { ${MCP_PRESET_FIELDS} }
          }`,
          { input: draft },
        );
      }
      setDialogOpen(false);
      await load();
    } catch (value) {
      setDialogError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await controlPlaneRequest(
        `mutation DeleteMcpToolPreset($id: ID!) { deleteMcpToolPreset(id: $id) { id } }`,
        { id },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const copyUrl = async (preset: McpToolPresetView) => {
    await copyText(`${baseMcpUrl}?preset=${encodeURIComponent(preset.id)}`);
    setCopiedId(preset.id);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button onClick={openCreate} type="button">
            <Plus /> {t("create")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> {t("loading")}
          </p>
        ) : presets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          presets.map((preset) => (
            <div
              className="flex flex-wrap items-start gap-3 rounded-lg border p-3"
              key={preset.id}
            >
              <span className="rounded-md bg-muted p-2">
                <ConfigurationIcon iconKey={preset.iconKey} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{preset.name}</p>
                {preset.description && (
                  <p className="text-sm text-muted-foreground">
                    {preset.description}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-1">
                  {preset.enabledForPlans && (
                    <Badge variant="outline">{t("plans")}</Badge>
                  )}
                  {preset.enabledForSessions && (
                    <Badge variant="outline">{t("sessions")}</Badge>
                  )}
                  {!preset.enabledForPlans && !preset.enabledForSessions && (
                    <Badge variant="secondary">{t("directOnly")}</Badge>
                  )}
                  <Badge variant="secondary">
                    {t("toolCount", { count: preset.toolNames.length })}
                  </Badge>
                </div>
                <code className="mt-2 block break-all text-xs text-muted-foreground">
                  {baseMcpUrl}?preset={preset.id}
                </code>
              </div>
              <div className="flex gap-1">
                <Button
                  aria-label={t("copyUrl")}
                  onClick={() => void copyUrl(preset)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  {copiedId === preset.id ? <Check /> : <Copy />}
                </Button>
                <Button
                  aria-label={t("edit")}
                  onClick={() => openEdit(preset)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Pencil />
                </Button>
                <ConfirmationDialog
                  actionLabel={t("delete")}
                  cancelLabel={tc("cancel")}
                  description={t("deleteDescription", { name: preset.name })}
                  onConfirm={() => remove(preset.id)}
                  title={t("deleteTitle")}
                  trigger={
                    <Button
                      aria-label={t("delete")}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  }
                />
              </div>
            </div>
          ))
        )}
      </CardContent>

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <form className="space-y-4" onSubmit={save}>
            <DialogHeader>
              <DialogTitle>
                {editing ? t("editTitle") : t("createTitle")}
              </DialogTitle>
              <DialogDescription>{t("dialogDescription")}</DialogDescription>
            </DialogHeader>
            {dialogError && (
              <Alert variant="destructive">
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
              <div className="space-y-2">
                <Label htmlFor="mcp-preset-name">{t("name")}</Label>
                <Input
                  id="mcp-preset-name"
                  maxLength={80}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  required
                  value={draft.name}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("icon")}</Label>
                <Select
                  onValueChange={(iconKey) => setDraft({ ...draft, iconKey })}
                  value={draft.iconKey}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BUILD_CONFIGURATION_ICON_KEYS.map((iconKey) => (
                      <SelectItem key={iconKey} value={iconKey}>
                        <ConfigurationIcon iconKey={iconKey} /> {iconKey}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-preset-description">
                {t("optionalDescription")}
              </Label>
              <Textarea
                id="mcp-preset-description"
                maxLength={1000}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
                value={draft.description}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded-lg border p-3">
                <Checkbox
                  checked={draft.enabledForPlans}
                  onCheckedChange={(value) =>
                    setDraft({ ...draft, enabledForPlans: Boolean(value) })
                  }
                />
                {t("availableForPlans")}
              </label>
              <label className="flex items-center gap-2 rounded-lg border p-3">
                <Checkbox
                  checked={draft.enabledForSessions}
                  onCheckedChange={(value) =>
                    setDraft({ ...draft, enabledForSessions: Boolean(value) })
                  }
                />
                {t("availableForSessions")}
              </label>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>{t("tools")}</Label>
                <Badge variant="secondary">
                  {t("selectedToolCount", { count: draft.toolNames.length })}
                </Badge>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("searchTools")}
                  type="search"
                  value={search}
                />
              </div>
              <div className="max-h-80 overflow-y-auto rounded-lg border p-3">
                {visibleGroups.length ? (
                  visibleGroups.map((group) => (
                    <ToolGroupPicker
                      allNames={allNames}
                      group={group}
                      key={group.id}
                      onToggle={toggleTools}
                      selected={new Set(draft.toolNames)}
                    />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("noMatchingTools")}
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => setDialogOpen(false)}
                type="button"
                variant="outline"
              >
                {tc("cancel")}
              </Button>
              <Button
                disabled={saving || !draft.toolNames.length}
                type="submit"
              >
                {saving && <Spinner />} {t("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
