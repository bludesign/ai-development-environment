"use client";

import { Archive, ChevronDown, CircleOff, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  BUILD_CONFIGURATION_ICON_KEYS,
  ConfigurationIcon,
} from "@/components/builds/configuration-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  COMMAND_CONCURRENCY_MODES,
  COMMAND_DEFINITION_FIELDS,
  commandConcurrencyKey,
  type CommandAgent,
  type CommandConcurrency,
  type CommandDefinition,
} from "./types";

type Form = {
  name: string;
  description: string;
  script: string;
  targetKind: CommandDefinition["targetKind"];
  targetAgentId: string;
  targetRepositoryId: string;
  restartPolicy: CommandDefinition["restartPolicy"];
  restartLimit: string;
  unlimitedRestarts: boolean;
  concurrency: CommandConcurrency;
  quickActionEnabled: boolean;
  quickActionIconKey: string;
  quickActionButtonVariant: string;
  notificationsEnabled: boolean;
};

const initial: Form = {
  name: "",
  description: "",
  script: "#!/bin/zsh\nset -e\n\n",
  targetKind: "ANY_WORKTREE",
  targetAgentId: "",
  targetRepositoryId: "",
  restartPolicy: "NEVER",
  restartLimit: "3",
  unlimitedRestarts: false,
  concurrency: "NON_EXCLUSIVE",
  quickActionEnabled: false,
  quickActionIconKey: "terminal",
  quickActionButtonVariant: "default",
  notificationsEnabled: true,
};

export function CommandEditor({ commandId }: { commandId?: string }) {
  const t = useTranslations("commands");
  const buildsT = useTranslations("builds");
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [agents, setAgents] = useState<CommandAgent[]>([]);
  const [repositories, setRepositories] = useState<
    Array<{ id: string; name: string; displayOrigin: string }>
  >([]);
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void controlPlaneRequest<{
      agents: CommandAgent[];
      codebaseOverview: {
        repositories: Array<{
          id: string;
          name: string;
          displayOrigin: string;
        }>;
      };
      commandDefinition?: CommandDefinition | null;
    }>(
      `query CommandEditor${commandId ? "($id: ID!)" : ""} {
      agents { id name hostname connectionStatus capabilities }
      codebaseOverview { repositories { id name displayOrigin } }
      ${commandId ? `commandDefinition(id: $id) { ${COMMAND_DEFINITION_FIELDS} }` : ""}
    }`,
      commandId ? { id: commandId } : undefined,
    )
      .then((data) => {
        setAgents(data.agents);
        setRepositories(data.codebaseOverview.repositories);
        if (data.commandDefinition) {
          const value = data.commandDefinition;
          setArchived(Boolean(value.archivedAt));
          setForm({
            name: value.name,
            description: value.description,
            script: value.script,
            targetKind: value.targetKind,
            targetAgentId: value.targetAgentId ?? "",
            targetRepositoryId: value.targetRepositoryId ?? "",
            restartPolicy: value.restartPolicy,
            restartLimit: String(value.restartLimit ?? 3),
            unlimitedRestarts: value.restartLimit === null,
            concurrency: value.concurrency,
            quickActionEnabled: value.quickActionEnabled,
            quickActionIconKey: value.quickActionIconKey,
            quickActionButtonVariant: value.quickActionButtonVariant,
            notificationsEnabled: value.notificationsEnabled,
          });
        }
      })
      .catch((value) =>
        setError(value instanceof Error ? value.message : String(value)),
      );
  }, [commandId]);

  const update = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true);
    try {
      const input = {
        name: form.name,
        description: form.description,
        script: form.script,
        targetKind: form.targetKind,
        targetAgentId:
          form.targetKind === "SPECIFIC_AGENT_HOME" ? form.targetAgentId : null,
        targetRepositoryId:
          form.targetKind === "REPOSITORY_WORKTREE"
            ? form.targetRepositoryId
            : null,
        restartPolicy: form.restartPolicy,
        restartLimit: form.unlimitedRestarts ? null : Number(form.restartLimit),
        concurrency: form.concurrency,
        quickActionEnabled: form.quickActionEnabled,
        quickActionIconKey: form.quickActionIconKey,
        quickActionButtonVariant: form.quickActionButtonVariant,
        notificationsEnabled: form.notificationsEnabled,
      };
      const data = await controlPlaneRequest<{
        createCommandDefinition?: { id: string };
        updateCommandDefinition?: { id: string };
      }>(
        commandId
          ? "mutation UpdateCommand($id: ID!, $input: CommandDefinitionInput!) { updateCommandDefinition(id: $id, input: $input) { id } }"
          : "mutation CreateCommand($input: CommandDefinitionInput!) { createCommandDefinition(input: $input) { id } }",
        commandId ? { id: commandId, input } : { input },
      );
      router.push(
        `/commands/${data.updateCommandDefinition?.id ?? data.createCommandDefinition?.id}/edit`,
      );
      router.refresh();
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold">
            {commandId ? t("editCommand") : t("newCommand")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("editorDescription")}
          </p>
        </div>
        {commandId && (
          <Button
            variant="outline"
            onClick={async () => {
              await controlPlaneRequest(
                "mutation ArchiveCommand($id: ID!, $archived: Boolean!) { archiveCommandDefinition(id: $id, archived: $archived) { id } }",
                { id: commandId, archived: !archived },
              );
              setArchived(!archived);
            }}
          >
            <Archive />
            {archived ? t("restore") : t("archive")}
          </Button>
        )}
        <Button disabled={saving} onClick={() => void save()}>
          <Save />
          {saving ? t("saving") : t("save")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{t("command")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="command-name">{t("name")}</Label>
            <Input
              id="command-name"
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="command-description">
              {t("commandDescription")}
            </Label>
            <Textarea
              id="command-description"
              value={form.description}
              onChange={(event) => update("description", event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="command-script">{t("script")}</Label>
            <Textarea
              className="min-h-64 font-mono text-sm"
              id="command-script"
              spellCheck={false}
              value={form.script}
              onChange={(event) => update("script", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("scriptHelp")}</p>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("target")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label>{t("scope")}</Label>
              <Select
                value={form.targetKind}
                onValueChange={(value) =>
                  update("targetKind", value as Form["targetKind"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ANY_AGENT_HOME">
                    {t("anyAgentHome")}
                  </SelectItem>
                  <SelectItem value="SPECIFIC_AGENT_HOME">
                    {t("specificAgentHome")}
                  </SelectItem>
                  <SelectItem value="ANY_WORKTREE">
                    {t("anyWorktree")}
                  </SelectItem>
                  <SelectItem value="REPOSITORY_WORKTREE">
                    {t("repositoryWorktree")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.targetKind === "SPECIFIC_AGENT_HOME" && (
              <div className="grid gap-2">
                <Label>{t("agent")}</Label>
                <Select
                  value={form.targetAgentId}
                  onValueChange={(value) =>
                    update("targetAgentId", value ?? "")
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("selectAgent")} />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name} · {agent.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {form.targetKind === "REPOSITORY_WORKTREE" && (
              <div className="grid gap-2">
                <Label>{t("repository")}</Label>
                <Select
                  value={form.targetRepositoryId}
                  onValueChange={(value) =>
                    update("targetRepositoryId", value ?? "")
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("selectRepository")} />
                  </SelectTrigger>
                  <SelectContent>
                    {repositories.map((repository) => (
                      <SelectItem key={repository.id} value={repository.id}>
                        {repository.name} · {repository.displayOrigin}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("restart")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label>{t("restartPolicy")}</Label>
              <Select
                value={form.restartPolicy}
                onValueChange={(value) =>
                  update("restartPolicy", value as Form["restartPolicy"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NEVER">{t("never")}</SelectItem>
                  <SelectItem value="ON_FAILURE">{t("onFailure")}</SelectItem>
                  <SelectItem value="ALWAYS">{t("always")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="restart-limit">{t("restartLimit")}</Label>
              <Input
                disabled={form.unlimitedRestarts}
                id="restart-limit"
                min={0}
                max={100}
                type="number"
                value={form.restartLimit}
                onChange={(event) => update("restartLimit", event.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.unlimitedRestarts}
                onCheckedChange={(checked) =>
                  update("unlimitedRestarts", checked === true)
                }
              />
              {t("unlimited")}
            </label>
            <p className="text-xs text-muted-foreground">{t("restartHelp")}</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("concurrency")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t("concurrencyHelp")}
          </p>
          <RadioGroup
            onValueChange={(value) =>
              update("concurrency", value as CommandConcurrency)
            }
            value={form.concurrency}
          >
            {COMMAND_CONCURRENCY_MODES.map((mode) => {
              const id = `command-concurrency-${mode}`;
              return (
                <FieldLabel
                  className="w-full cursor-pointer"
                  htmlFor={id}
                  key={mode}
                >
                  <Item size="sm" variant="outline">
                    <RadioGroupItem id={id} value={mode} />
                    <ItemContent>
                      <ItemTitle>{t(commandConcurrencyKey(mode))}</ItemTitle>
                      <ItemDescription>
                        {t(`${commandConcurrencyKey(mode)}Help` as never)}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                </FieldLabel>
              );
            })}
          </RadioGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("notifications")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.notificationsEnabled}
              onCheckedChange={(checked) =>
                update("notificationsEnabled", checked === true)
              }
            />
            {t("enableNotifications")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("notificationsHelp")}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("quickAction")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.quickActionEnabled}
              onCheckedChange={(checked) =>
                update("quickActionEnabled", checked === true)
              }
            />
            {t("enableQuickAction")}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="command-quick-action-icon">{t("icon")}</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label={`${t("icon")}: ${buildsT(
                      `configurationIcons.${form.quickActionIconKey}` as never,
                    )}`}
                    className="w-full justify-between"
                    id="command-quick-action-icon"
                    type="button"
                    variant="outline"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {form.quickActionIconKey === "none" ? (
                        <CircleOff className="size-4 shrink-0" />
                      ) : (
                        <ConfigurationIcon iconKey={form.quickActionIconKey} />
                      )}
                      <span className="truncate">
                        {buildsT(
                          `configurationIcons.${form.quickActionIconKey}` as never,
                        )}
                      </span>
                    </span>
                    <ChevronDown className="text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  <DropdownMenuRadioGroup
                    onValueChange={(value) =>
                      update("quickActionIconKey", value)
                    }
                    value={form.quickActionIconKey}
                  >
                    {["none", ...BUILD_CONFIGURATION_ICON_KEYS].map((value) => (
                      <DropdownMenuRadioItem key={value} value={value}>
                        {value === "none" ? (
                          <CircleOff className="size-4" />
                        ) : (
                          <ConfigurationIcon iconKey={value} />
                        )}
                        {buildsT(`configurationIcons.${value}` as never)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="grid gap-2">
              <Label>{t("style")}</Label>
              <Select
                value={form.quickActionButtonVariant}
                onValueChange={(value) =>
                  update("quickActionButtonVariant", value ?? "default")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("defaultStyle")}</SelectItem>
                  <SelectItem value="outline">{t("outlineStyle")}</SelectItem>
                  <SelectItem value="secondary">
                    {t("secondaryStyle")}
                  </SelectItem>
                  <SelectItem value="destructive">
                    {t("destructiveStyle")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
