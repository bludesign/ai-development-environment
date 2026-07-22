"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Server,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  FormEvent,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { copyText } from "@/lib/browser-utils";
import { cn } from "@/lib/utils";

import type {
  ExternalMcpHeaderDraft,
  ExternalMcpServerDraft,
  ExternalMcpServerView,
  ToolCatalogGroup,
} from "./types";

const SERVER_FIELDS =
  "id name url transport toolNamePrefix createdAt updatedAt headers { id name valueConfigured }";

type JsonSchema = Record<string, unknown>;

const emptyDraft = (): ExternalMcpServerDraft => ({
  name: "",
  url: "",
  transport: "STREAMABLE_HTTP",
  toolNamePrefix: "",
  headers: [],
});

function serverDraft(server: ExternalMcpServerView): ExternalMcpServerDraft {
  return {
    name: server.name,
    url: server.url,
    transport: server.transport,
    toolNamePrefix: server.toolNamePrefix,
    headers: server.headers.map((header) => ({
      id: header.id,
      name: header.name,
      value: "",
      valueConfigured: header.valueConfigured,
    })),
  };
}

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? (body.error as { message?: unknown })
        : null;
    throw new Error(
      typeof error?.message === "string"
        ? error.message
        : `HTTP ${response.status}`,
    );
  }
  return body;
}

export function ToolsPage() {
  const t = useTranslations("tools");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [servers, setServers] = useState<ExternalMcpServerView[]>([]);
  const [groups, setGroups] = useState<ToolCatalogGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExternalMcpServerView | null>(null);
  const [draft, setDraft] = useState<ExternalMcpServerDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    const data = await controlPlaneRequest<{
      externalMcpServers: ExternalMcpServerView[];
    }>(`query ExternalMcpServers { externalMcpServers { ${SERVER_FIELDS} } }`);
    setServers(data.externalMcpServers);
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const body = (await responseJson(
        await fetch("/api/tools/catalog", { cache: "no-store" }),
      )) as { groups: ToolCatalogGroup[] };
      setGroups(body.groups);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void Promise.all([loadServers(), loadCatalog()])
        .catch((value) =>
          setError(value instanceof Error ? value.message : String(value)),
        )
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadCatalog, loadServers]);

  const visibleGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return groups;
    return groups.flatMap((group) => {
      const filtered = filterToolGroup(group, needle);
      return filtered ? [filtered] : [];
    });
  }, [groups, query]);

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft());
    setDialogError(null);
    setDialogOpen(true);
  };

  const openEdit = (server: ExternalMcpServerView) => {
    setEditing(server);
    setDraft(serverDraft(server));
    setDialogError(null);
    setDialogOpen(true);
  };

  const saveServer = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setDialogError(null);
    const input = {
      ...draft,
      headers: draft.headers.map((header) => ({
        id: header.id ?? null,
        name: header.name,
        value: header.value || null,
      })),
    };
    try {
      if (editing) {
        await controlPlaneRequest(
          `mutation UpdateExternalMcpServer($id: ID!, $input: ExternalMcpServerInput!) {
            updateExternalMcpServer(id: $id, input: $input) { id }
          }`,
          { id: editing.id, input },
        );
      } else {
        await controlPlaneRequest(
          `mutation CreateExternalMcpServer($input: ExternalMcpServerInput!) {
            createExternalMcpServer(input: $input) { id }
          }`,
          { input },
        );
      }
      setDialogOpen(false);
      await Promise.all([loadServers(), loadCatalog()]);
    } catch (value) {
      setDialogError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  };

  const deleteServer = async (id: string) => {
    try {
      await controlPlaneRequest(
        `mutation DeleteExternalMcpServer($id: ID!) {
          deleteExternalMcpServer(id: $id) { id }
        }`,
        { id },
      );
      await Promise.all([loadServers(), loadCatalog()]);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button onClick={openCreate} type="button">
          <Plus />
          {t("addServer")}
        </Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t("search")}
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          type="search"
          value={query}
        />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 py-0">
        <CardHeader>
          <CardTitle>{t("serversTitle")}</CardTitle>
          <CardDescription>{t("serversDescription")}</CardDescription>
        </CardHeader>
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner /> {t("loadingServers")}
          </div>
        ) : servers.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{t("noServers")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("url")}</TableHead>
                <TableHead>{t("transport")}</TableHead>
                <TableHead>{t("prefix")}</TableHead>
                <TableHead className="text-right">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((server) => (
                <TableRow key={server.id}>
                  <TableCell className="font-medium">{server.name}</TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs">
                    {server.url}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {server.transport === "STREAMABLE_HTTP"
                        ? t("http")
                        : t("sse")}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {server.toolNamePrefix || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        aria-label={t("editServer", { name: server.name })}
                        onClick={() => openEdit(server)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Pencil />
                      </Button>
                      <ConfirmationDialog
                        actionLabel={t("delete")}
                        cancelLabel={tc("cancel")}
                        description={t("confirmDeleteDescription", {
                          name: server.name,
                        })}
                        onConfirm={() => deleteServer(server.id)}
                        title={t("confirmDelete")}
                        trigger={
                          <Button
                            aria-label={t("deleteServer", {
                              name: server.name,
                            })}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <Trash2 />
                          </Button>
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("catalogTitle")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("catalogDescription")}
          </p>
        </div>
        <Button
          disabled={catalogLoading}
          onClick={() => void loadCatalog()}
          type="button"
          variant="outline"
        >
          {catalogLoading ? <Spinner /> : <RotateCw />}
          {t("refresh")}
        </Button>
      </div>

      {catalogLoading && groups.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loadingTools")}
        </div>
      ) : visibleGroups.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noMatchingTools")}</p>
      ) : (
        visibleGroups.map((group) => <ToolGroup group={group} key={group.id} />)
      )}

      <ServerDialog
        draft={draft}
        editing={editing}
        error={dialogError}
        onDraftChange={setDraft}
        onOpenChange={setDialogOpen}
        onSubmit={saveServer}
        open={dialogOpen}
        saving={saving}
      />
    </section>
  );
}

function ServerDialog({
  draft,
  editing,
  error,
  onDraftChange,
  onOpenChange,
  onSubmit,
  open,
  saving,
}: {
  draft: ExternalMcpServerDraft;
  editing: ExternalMcpServerView | null;
  error: string | null;
  onDraftChange: (draft: ExternalMcpServerDraft) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  open: boolean;
  saving: boolean;
}) {
  const t = useTranslations("tools");
  const tc = useTranslations("common");
  const updateHeader = (
    index: number,
    change: Partial<ExternalMcpHeaderDraft>,
  ) => {
    onDraftChange({
      ...draft,
      headers: draft.headers.map((header, current) =>
        current === index ? { ...header, ...change } : header,
      ),
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <form className="space-y-4" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editing ? t("editServerTitle") : t("addServerTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("serverDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("name")}>
              <Input
                aria-label={t("name")}
                onChange={(event) =>
                  onDraftChange({ ...draft, name: event.target.value })
                }
                required
                value={draft.name}
              />
            </Field>
            <Field label={t("transport")}>
              <Select
                onValueChange={(value) =>
                  onDraftChange({
                    ...draft,
                    transport: value as ExternalMcpServerDraft["transport"],
                  })
                }
                value={draft.transport}
              >
                <SelectTrigger aria-label={t("transport")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STREAMABLE_HTTP">{t("http")}</SelectItem>
                  <SelectItem value="SSE">{t("sse")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label={t("url")}>
            <Input
              aria-label={t("url")}
              onChange={(event) =>
                onDraftChange({ ...draft, url: event.target.value })
              }
              placeholder="https://example.com/mcp"
              required
              type="url"
              value={draft.url}
            />
          </Field>
          <Field label={t("prefix")}>
            <Input
              aria-label={t("prefix")}
              className="font-mono"
              onChange={(event) =>
                onDraftChange({ ...draft, toolNamePrefix: event.target.value })
              }
              placeholder="example_"
              value={draft.toolNamePrefix}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("prefixHelp")}
            </p>
          </Field>
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>{t("headers")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("headersHelp")}
                </p>
              </div>
              <Button
                onClick={() =>
                  onDraftChange({
                    ...draft,
                    headers: [
                      ...draft.headers,
                      {
                        name: "",
                        value: "",
                        valueConfigured: false,
                      },
                    ],
                  })
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <Plus /> {t("addHeader")}
              </Button>
            </div>
            {draft.headers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("noHeaders")}</p>
            ) : (
              draft.headers.map((header, index) => (
                <div
                  className="grid items-start gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  key={header.id ?? index}
                >
                  <Input
                    aria-label={t("headerName")}
                    onChange={(event) =>
                      updateHeader(index, { name: event.target.value })
                    }
                    placeholder="Authorization"
                    required
                    value={header.name}
                  />
                  <div>
                    <Input
                      aria-label={t("headerValue")}
                      autoComplete="new-password"
                      onChange={(event) =>
                        updateHeader(index, { value: event.target.value })
                      }
                      placeholder={
                        header.valueConfigured
                          ? t("keepHeaderValue")
                          : t("headerValue")
                      }
                      required={!header.valueConfigured}
                      type="password"
                      value={header.value}
                    />
                  </div>
                  <Button
                    aria-label={t("removeHeader")}
                    onClick={() =>
                      onDraftChange({
                        ...draft,
                        headers: draft.headers.filter(
                          (_item, current) => current !== index,
                        ),
                      })
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <X />
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button
              disabled={saving}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {tc("cancel")}
            </Button>
            <Button disabled={saving} type="submit">
              {saving && <Spinner />}
              {t("saveServer")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div>
      <Label className="mb-1.5 block">{label}</Label>
      {children}
    </div>
  );
}

function groupToolCount(group: ToolCatalogGroup): number {
  return (
    group.tools.length +
    (group.children ?? []).reduce(
      (count, child) => count + groupToolCount(child),
      0,
    )
  );
}

function filterToolGroup(
  group: ToolCatalogGroup,
  needle: string,
): ToolCatalogGroup | null {
  const children = group.children ?? [];
  const groupMatches = [group.name, group.url ?? ""].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
  if (groupMatches) return { ...group, children };
  const tools = group.tools.filter((tool) =>
    [tool.name, tool.title ?? "", tool.description ?? ""].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    ),
  );
  const filteredChildren = children.flatMap((child) => {
    const filtered = filterToolGroup(child, needle);
    return filtered ? [filtered] : [];
  });
  return tools.length || filteredChildren.length
    ? { ...group, tools, children: filteredChildren }
    : null;
}

function ToolGroup({
  group,
  nested = false,
}: {
  group: ToolCatalogGroup;
  nested?: boolean;
}) {
  const t = useTranslations("tools");
  const children = group.children ?? [];
  return (
    <Card className={cn("gap-0 py-0", nested && "bg-background")}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="flex items-center gap-2">
          {group.source === "BUILTIN" ? (
            <Wrench className="size-5" />
          ) : (
            <Server className="size-5" />
          )}
          <div>
            <h3 className="font-semibold">{group.name}</h3>
            {group.url && (
              <p className="font-mono text-xs text-muted-foreground">
                {group.url}
              </p>
            )}
          </div>
        </div>
        <Badge variant="outline">
          {t("toolCount", { count: groupToolCount(group) })}
        </Badge>
      </div>
      {group.error && (
        <div className="border-b p-4">
          <Alert variant="destructive">
            <AlertDescription>{group.error}</AlertDescription>
          </Alert>
        </div>
      )}
      {group.tools.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>{t("tool")}</TableHead>
              <TableHead>{t("toolDescription")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.tools.map((tool) => (
              <ToolRow groupId={group.id} key={tool.name} tool={tool} />
            ))}
          </TableBody>
        </Table>
      )}
      {children.length > 0 && (
        <div className="space-y-3 border-t bg-muted/20 p-4">
          {children.map((child) => (
            <ToolGroup group={child} key={child.id} nested />
          ))}
        </div>
      )}
    </Card>
  );
}

function ToolRow({
  groupId,
  tool,
}: {
  groupId: string;
  tool: ToolCatalogGroup["tools"][number];
}) {
  const t = useTranslations("tools");
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = () => setExpanded((value) => !value);
  return (
    <Fragment>
      <TableRow
        aria-expanded={expanded}
        aria-label={
          expanded
            ? t("collapseTool", { name: tool.name })
            : t("expandTool", { name: tool.name })
        }
        className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={toggleExpanded}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleExpanded();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <TableCell>
          {expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </TableCell>
        <TableCell>
          <p className="font-mono text-xs font-medium">{tool.name}</p>
          {tool.title && tool.title !== tool.name && (
            <p className="text-xs text-muted-foreground">{tool.title}</p>
          )}
        </TableCell>
        <TableCell className="max-w-2xl whitespace-normal text-muted-foreground">
          {tool.description || t("noDescription")}
        </TableCell>
      </TableRow>
      <TableRow
        className={expanded ? "bg-muted/20 hover:bg-muted/20" : "hidden"}
      >
        <TableCell colSpan={3} className="whitespace-normal p-4">
          <ToolRunner
            groupId={groupId}
            schema={tool.inputSchema}
            toolName={tool.name}
          />
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function defaultsForSchema(schema: JsonSchema): unknown {
  if ("default" in schema) return schema.default;
  if (schema.type === "object") {
    const properties = asProperties(schema.properties);
    const required = new Set(asStringArray(schema.required));
    return Object.fromEntries(
      Object.entries(properties).flatMap(([name, property]) => {
        if ("default" in property || required.has(name)) {
          const value = defaultsForSchema(property);
          if (value !== undefined) return [[name, value]];
        }
        return [];
      }),
    );
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "string") return "";
  return undefined;
}

function asProperties(value: unknown): Record<string, JsonSchema> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, JsonSchema] =>
        Boolean(entry[1]) &&
        typeof entry[1] === "object" &&
        !Array.isArray(entry[1]),
    ),
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function acceptsDynamicRootArguments(schema: JsonSchema): boolean {
  return (
    Object.keys(asProperties(schema.properties)).length === 0 &&
    schema.additionalProperties !== false
  );
}

function setAtPath(
  source: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const next = structuredClone(source);
  let target = next;
  path.slice(0, -1).forEach((part) => {
    const child = target[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      target[part] = {};
    }
    target = target[part] as Record<string, unknown>;
  });
  const name = path.at(-1);
  if (!name) return next;
  if (value === undefined) delete target[name];
  else target[name] = value;
  return next;
}

function getAtPath(source: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = source;
  for (const part of path) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function ToolRunner({
  groupId,
  schema,
  toolName,
}: {
  groupId: string;
  schema: JsonSchema;
  toolName: string;
}) {
  const t = useTranslations("tools");
  const [argumentsValue, setArgumentsValue] = useState<Record<string, unknown>>(
    () => (defaultsForSchema(schema) as Record<string, unknown>) ?? {},
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"IDLE" | "COPIED" | "FAILED">(
    "IDLE",
  );
  const properties = asProperties(schema.properties);
  const dynamicRootArguments = acceptsDynamicRootArguments(schema);
  const required = new Set(asStringArray(schema.required));
  const rootArgumentsId = `${groupId}-${toolName}-arguments`;

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCopyState("IDLE");
    try {
      const body = (await responseJson(
        await fetch("/api/tools/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupId,
            name: toolName,
            arguments: argumentsValue,
          }),
        }),
      )) as { result: unknown };
      setResult(body.result);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  };

  const responseText =
    result === undefined ? "" : JSON.stringify(result, null, 2);
  const copyResponse = async () => {
    try {
      await copyText(responseText);
      setCopyState("COPIED");
    } catch {
      setCopyState("FAILED");
    }
  };

  return (
    <form className="grid gap-4 lg:grid-cols-2" onSubmit={run}>
      <div className="space-y-4">
        <h4 className="text-sm font-medium">{t("parameters")}</h4>
        {dynamicRootArguments ? (
          <div>
            <Label className="mb-1.5 block" htmlFor={rootArgumentsId}>
              {t("jsonArguments")}
            </Label>
            <JsonParameter
              id={rootArgumentsId}
              objectOnly
              onChange={(next) =>
                setArgumentsValue(next as Record<string, unknown>)
              }
              required
              value={argumentsValue}
            />
          </div>
        ) : Object.keys(properties).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noParameters")}</p>
        ) : (
          Object.entries(properties).map(([name, property]) => (
            <ParameterField
              key={name}
              name={name}
              onChange={(path, value) =>
                setArgumentsValue((current) => setAtPath(current, path, value))
              }
              path={[name]}
              required={required.has(name)}
              schema={property}
              value={getAtPath(argumentsValue, [name])}
            />
          ))
        )}
        <Button disabled={busy} type="submit">
          {busy ? <Spinner /> : <Wrench />}
          {busy ? t("running") : t("run")}
        </Button>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex min-h-7 items-center justify-between gap-2">
          <h4 className="text-sm font-medium">{t("response")}</h4>
          {result !== undefined && (
            <Button
              aria-label={
                copyState === "COPIED" ? t("copied") : t("copyResponse")
              }
              onClick={() => void copyResponse()}
              size="icon-sm"
              title={copyState === "COPIED" ? t("copied") : t("copyResponse")}
              type="button"
              variant="ghost"
            >
              {copyState === "COPIED" ? <Check /> : <Copy />}
            </Button>
          )}
        </div>
        {copyState === "FAILED" && (
          <p className="text-xs text-destructive">{t("copyFailed")}</p>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : result === undefined ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            {t("noResponse")}
          </div>
        ) : (
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {responseText}
          </pre>
        )}
      </div>
    </form>
  );
}

function ParameterField({
  name,
  onChange,
  path,
  required,
  schema,
  value,
}: {
  name: string;
  onChange: (path: string[], value: unknown) => void;
  path: string[];
  required: boolean;
  schema: JsonSchema;
  value: unknown;
}) {
  const t = useTranslations("tools");
  const description =
    typeof schema.description === "string" ? schema.description : null;
  const label =
    typeof schema.title === "string" && schema.title ? schema.title : name;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : null;

  let control: React.ReactNode;
  if (enumValues) {
    const selected = value === undefined ? "__unset" : JSON.stringify(value);
    control = (
      <Select
        onValueChange={(next) =>
          onChange(path, next === "__unset" ? undefined : JSON.parse(next))
        }
        value={selected}
      >
        <SelectTrigger className="w-full" id={path.join("-")}>
          <SelectValue placeholder={t("selectValue")} />
        </SelectTrigger>
        <SelectContent>
          {!required && <SelectItem value="__unset">{t("unset")}</SelectItem>}
          {enumValues.map((item) => (
            <SelectItem key={JSON.stringify(item)} value={JSON.stringify(item)}>
              {String(item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (schema.type === "boolean") {
    control = required ? (
      <div className="flex items-center gap-2 py-1">
        <Checkbox
          checked={Boolean(value)}
          id={path.join("-")}
          onCheckedChange={(checked) => onChange(path, checked === true)}
        />
        <span className="text-sm">
          {Boolean(value) ? t("true") : t("false")}
        </span>
      </div>
    ) : (
      <Select
        onValueChange={(next) =>
          onChange(path, next === "unset" ? undefined : next === "true")
        }
        value={value === undefined ? "unset" : String(Boolean(value))}
      >
        <SelectTrigger className="w-full" id={path.join("-")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unset">{t("unset")}</SelectItem>
          <SelectItem value="true">{t("true")}</SelectItem>
          <SelectItem value="false">{t("false")}</SelectItem>
        </SelectContent>
      </Select>
    );
  } else if (schema.type === "number" || schema.type === "integer") {
    control = (
      <Input
        id={path.join("-")}
        max={typeof schema.maximum === "number" ? schema.maximum : undefined}
        min={typeof schema.minimum === "number" ? schema.minimum : undefined}
        onChange={(event) =>
          onChange(
            path,
            event.target.value === "" ? undefined : Number(event.target.value),
          )
        }
        required={required}
        step={schema.type === "integer" ? 1 : "any"}
        type="number"
        value={typeof value === "number" ? value : ""}
      />
    );
  } else if (schema.type === "string") {
    control = (
      <Input
        id={path.join("-")}
        maxLength={
          typeof schema.maxLength === "number" ? schema.maxLength : undefined
        }
        minLength={
          typeof schema.minLength === "number" ? schema.minLength : undefined
        }
        onChange={(event) =>
          onChange(
            path,
            !required && event.target.value === ""
              ? undefined
              : event.target.value,
          )
        }
        required={required}
        value={typeof value === "string" ? value : ""}
      />
    );
  } else if (
    schema.type === "object" &&
    Object.keys(asProperties(schema.properties)).length
  ) {
    const properties = asProperties(schema.properties);
    const childRequired = new Set(asStringArray(schema.required));
    control = (
      <div className="space-y-3 rounded-lg border p-3">
        {Object.entries(properties).map(([childName, childSchema]) => (
          <ParameterField
            key={childName}
            name={childName}
            onChange={onChange}
            path={[...path, childName]}
            required={required && childRequired.has(childName)}
            schema={childSchema}
            value={
              value && typeof value === "object" && !Array.isArray(value)
                ? (value as Record<string, unknown>)[childName]
                : undefined
            }
          />
        ))}
      </div>
    );
  } else {
    control = (
      <JsonParameter
        id={path.join("-")}
        onChange={(next) => onChange(path, next)}
        required={required}
        value={value}
      />
    );
  }

  return (
    <div>
      <Label className="mb-1.5 block" htmlFor={path.join("-")}>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {control}
      {description && (
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

function JsonParameter({
  id,
  objectOnly = false,
  onChange,
  required,
  value,
}: {
  id: string;
  objectOnly?: boolean;
  onChange: (value: unknown) => void;
  required: boolean;
  value: unknown;
}) {
  const t = useTranslations("tools");
  const [text, setText] = useState(() =>
    value === undefined ? "" : JSON.stringify(value, null, 2),
  );
  return (
    <Textarea
      id={id}
      className="min-h-24 font-mono text-xs"
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (!next && !required) {
          event.target.setCustomValidity("");
          onChange(undefined);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(next);
          if (
            objectOnly &&
            (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          ) {
            event.target.setCustomValidity(t("invalidJsonObject"));
            return;
          }
          onChange(parsed);
          event.target.setCustomValidity("");
        } catch {
          event.target.setCustomValidity(t("invalidJson"));
        }
      }}
      placeholder={
        objectOnly ? t("jsonObjectPlaceholder") : t("jsonPlaceholder")
      }
      required={required}
      value={text}
    />
  );
}
