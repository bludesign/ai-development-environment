"use client";

import {
  useBreadcrumbLabel,
  useBreadcrumbFallback,
} from "@/components/breadcrumb-labels-provider";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Pencil } from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PublicOrigin } from "@/lib/public-origin";
import { ConfigurationIcon } from "./configuration-icon";
import { AndroidBuildConfigurationDialog } from "./android-project-section";
import { BuildConfigurationDialog } from "./ios-project-section";
import { BuildsPage } from "./builds-page";
import {
  configurationPlatforms,
  platformLabel,
  settingsForPlatform,
  type AndroidBuildConfiguration,
  type BuildConfiguration,
} from "./types";
import {
  ANDROID_BUILD_CONFIGURATION_FIELDS,
  BUILD_PLATFORM_CONFIGURATION_FIELDS,
} from "./graphql-fields";

const FIELDS = `id name iconKey scheme buildConfiguration defaultAction advancedSettings autoExport exportSettings createdAt updatedAt
  source { id kind relativePath }
  platformConfigurations { ${BUILD_PLATFORM_CONFIGURATION_FIELDS} }
  repository { id name }`;
const ANDROID_FIELDS = `${ANDROID_BUILD_CONFIGURATION_FIELDS} repository { id name }`;
type Repository = { id: string; name: string };
type AppleConfiguration = BuildConfiguration & { repository: Repository };
type AndroidConfiguration = AndroidBuildConfiguration & {
  repository: Repository;
};
type Configuration = AppleConfiguration | AndroidConfiguration;
type Checkout = {
  codebaseId: string;
  worktreeId: string;
  label: string;
};

export function BuildConfigurations() {
  const t = useTranslations("builds");
  const [items, setItems] = useState<Configuration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        buildConfigurations: AppleConfiguration[];
        androidBuildConfigurations?: AndroidConfiguration[];
      }>(
        `query BuildConfigurations { buildConfigurations { ${FIELDS} } androidBuildConfigurations { ${ANDROID_FIELDS} } }`,
      );
      setItems([
        ...data.buildConfigurations,
        ...(data.androidBuildConfigurations ?? []),
      ]);
      setError(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
    return controlPlaneSubscriptions().subscribe(
      {
        query:
          "subscription ConfigurationCatalogChanged { codebaseOverviewChanged { repositoryId } }",
      },
      { next: () => void load(), error: () => {}, complete: () => {} },
    );
  }, [load]);
  if (loading) return <Spinner />;
  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!items.length && (
        <p className="text-muted-foreground">{t("noConfigurations")}</p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <Link
            href={`/dashboard/builds/configurations/${item.id}`}
            key={item.id}
          >
            <Card className="h-full hover:bg-muted/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ConfigurationIcon iconKey={item.iconKey} />
                  {item.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>{item.repository.name}</p>
                {"projectPath" in item ? (
                  <>
                    <p className="text-muted-foreground">
                      {platformLabel("ANDROID")}
                    </p>
                    <p className="break-all font-mono text-xs">
                      {item.projectPath} · {item.module} · {item.variant}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-muted-foreground">
                      {configurationPlatforms(item)
                        .map(({ platform }) => platformLabel(platform))
                        .join(" · ")}
                    </p>
                    <p className="text-muted-foreground">
                      {item.scheme} · {item.buildConfiguration} ·{" "}
                      {t(`actions.${item.defaultAction}`)}
                    </p>
                    <p className="break-all font-mono text-xs">
                      {item.source.relativePath}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function BuildConfigurationDetail({
  id,
  publicOrigin,
}: {
  id: string;
  publicOrigin: PublicOrigin | null;
}) {
  const t = useTranslations("builds");
  const androidT = useTranslations("androidBuilds");
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  useBreadcrumbLabel(
    ["dashboard", "builds", "configurations", configuration?.id],
    configuration?.name,
  );
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useBreadcrumbFallback(
    ["dashboard", "builds", "configurations", id],
    Boolean(error) || (!loading && !configuration),
  );
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        buildConfiguration: AppleConfiguration | null;
        androidBuildConfiguration?: AndroidConfiguration | null;
        worktreeOverview: {
          agents: Array<{
            agent: {
              name: string;
              connectionStatus: string;
              capabilities: string[];
            };
            codebases: Array<{
              codebase: { id: string };
              repository: { id: string };
              worktrees: Array<{
                id: string;
                folder: string;
                branch: string | null;
                primary: boolean;
                availability: string;
              }>;
            }>;
          }>;
        };
      }>(
        `query BuildConfigurationDetail($id: ID!) {
        buildConfiguration(id: $id) { ${FIELDS} }
        androidBuildConfiguration(id: $id) { ${ANDROID_FIELDS} }
        worktreeOverview { agents { agent { name connectionStatus capabilities } codebases { codebase { id } repository { id } worktrees { id folder branch primary availability } } } }
      }`,
        { id },
      );
      const result =
        data.buildConfiguration ?? data.androidBuildConfiguration ?? null;
      setConfiguration(result);
      const android = result && "projectPath" in result;
      const choices = data.worktreeOverview.agents.flatMap(
        ({ agent, codebases }) =>
          agent.connectionStatus !== "ONLINE" ||
          (!android && !agent.capabilities.includes("ios.source.parse"))
            ? []
            : codebases.flatMap((group) => {
                if (group.repository.id !== result?.repository.id) return [];
                const tree =
                  group.worktrees.find(
                    (tree) => tree.primary && tree.availability === "AVAILABLE",
                  ) ??
                  group.worktrees.find(
                    (tree) => tree.availability === "AVAILABLE",
                  );
                return tree
                  ? [
                      {
                        codebaseId: group.codebase.id,
                        worktreeId: tree.id,
                        label: `${agent.name} · ${tree.branch ?? tree.folder}`,
                      },
                    ]
                  : [];
              }),
      );
      setCheckouts(choices);
      setSelected((current) =>
        choices.some((choice) => choice.worktreeId === current)
          ? current
          : (choices[0]?.worktreeId ?? ""),
      );
      setError(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  const checkout = checkouts.find((item) => item.worktreeId === selected);
  if (loading) return <Spinner />;
  return (
    <section className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {configuration && "projectPath" in configuration ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <ConfigurationIcon iconKey={configuration.iconKey} />
              {configuration.name}
            </h1>
            <Button disabled={!checkout} onClick={() => setEditing(true)}>
              <Pencil /> {androidT("editConfiguration")}
            </Button>
          </div>
          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("repository")}
                </p>
                <Link
                  href={`/dashboard/codebases/repositories/${configuration.repository.id}`}
                >
                  {configuration.repository.name}
                </Link>
              </div>
              {(["projectPath", "module", "variant", "apkPath"] as const).map(
                (field) =>
                  configuration[field] && (
                    <div key={field}>
                      <p className="text-sm text-muted-foreground">
                        {androidT(field)}
                      </p>
                      <p className="break-all font-mono text-sm">
                        {configuration[field]}
                      </p>
                    </div>
                  ),
              )}
            </CardContent>
          </Card>
          <BuildsPage configurationId={id} publicOrigin={publicOrigin} />
          {editing && checkout && (
            <AndroidBuildConfigurationDialog
              codebaseId={checkout.codebaseId}
              configuration={configuration}
              repositoryId={configuration.repository.id}
              onClose={() => setEditing(false)}
              onSaved={() => void load()}
            />
          )}
        </>
      ) : configuration ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <ConfigurationIcon iconKey={configuration.iconKey} />
              {configuration.name}
            </h1>
            <Button disabled={!checkout} onClick={() => setEditing(true)}>
              <Pencil />
              {t("editConfiguration")}
            </Button>
          </div>
          <Card>
            <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("repository")}
                </p>
                <Link
                  href={`/dashboard/codebases/repositories/${configuration.repository.id}`}
                >
                  {configuration.repository.name}
                </Link>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("source")}</p>
                <p className="break-all font-mono text-sm">
                  {configuration.source.relativePath}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("scheme")}</p>
                {configuration.scheme}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("configuration")}
                </p>
                {configuration.buildConfiguration}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{t("action")}</p>
                {t(`actions.${configuration.defaultAction}`)}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {t("parseCheckout")}
                </p>
                {checkouts.length ? (
                  <Select value={selected} onValueChange={setSelected}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {checkouts.map((item) => (
                        <SelectItem
                          key={item.worktreeId}
                          value={item.worktreeId}
                        >
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  t("checkoutUnavailable")
                )}
              </div>
              <div className="space-y-2 sm:col-span-2">
                <p className="text-sm text-muted-foreground">
                  {t("buildPlatforms")}
                </p>
                {configurationPlatforms(configuration).map(({ platform }) => {
                  const settings = settingsForPlatform(configuration, platform);
                  return (
                    <div
                      className="rounded-lg border p-3 text-sm"
                      key={platform}
                    >
                      <p className="font-medium">{platformLabel(platform)}</p>
                      <p>
                        {settings.scheme} · {settings.buildConfiguration} ·{" "}
                        {t(`actions.${settings.defaultAction}`)}
                      </p>
                      <p className="break-all font-mono text-xs text-muted-foreground">
                        {settings.source.relativePath}
                      </p>
                    </div>
                  );
                })}
              </div>
              <details className="sm:col-span-2">
                <summary>{t("advancedSettings")}</summary>
                <pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">
                  {JSON.stringify(
                    {
                      ...configuration.advancedSettings,
                      autoExport: configuration.autoExport,
                      exportSettings: configuration.exportSettings,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </CardContent>
          </Card>
          <BuildsPage configurationId={id} publicOrigin={publicOrigin} />
          {editing && checkout && (
            <BuildConfigurationDialog
              codebaseId={checkout.codebaseId}
              worktreeId={checkout.worktreeId}
              configuration={configuration}
              open={editing}
              onOpenChange={setEditing}
              onSaved={load}
            />
          )}
        </>
      ) : (
        <p>{t("configurationNotFound")}</p>
      )}
    </section>
  );
}
