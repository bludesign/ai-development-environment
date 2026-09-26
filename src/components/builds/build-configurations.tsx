"use client";

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
import { BuildConfigurationDialog } from "./ios-project-section";
import { BuildsPage } from "./builds-page";
import type { BuildConfiguration } from "./types";

const FIELDS = `id name iconKey scheme buildConfiguration defaultAction advancedSettings autoExport exportSettings createdAt updatedAt
  source { id kind relativePath }
  repository { id name }`;
type Configuration = BuildConfiguration & {
  repository: { id: string; name: string };
};
type Checkout = { codebaseId: string; worktreeId: string; label: string };

export function BuildConfigurations() {
  const t = useTranslations("builds");
  const [items, setItems] = useState<Configuration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        buildConfigurations: Configuration[];
      }>(`query BuildConfigurations { buildConfigurations { ${FIELDS} } }`);
      setItems(data.buildConfigurations);
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
          <Link href={`/builds/configurations/${item.id}`} key={item.id}>
            <Card className="h-full hover:bg-muted/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ConfigurationIcon iconKey={item.iconKey} />
                  {item.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>{item.repository.name}</p>
                <p className="text-muted-foreground">
                  {item.scheme} · {item.buildConfiguration} ·{" "}
                  {t(`actions.${item.defaultAction}`)}
                </p>
                <p className="break-all font-mono text-xs">
                  {item.source.relativePath}
                </p>
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
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        buildConfiguration: Configuration | null;
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
        worktreeOverview { agents { agent { name connectionStatus capabilities } codebases { codebase { id } repository { id } worktrees { id folder branch primary availability } } } }
      }`,
        { id },
      );
      setConfiguration(data.buildConfiguration);
      const choices = data.worktreeOverview.agents.flatMap(
        ({ agent, codebases }) =>
          agent.connectionStatus !== "ONLINE" ||
          !agent.capabilities.includes("ios.source.parse")
            ? []
            : codebases.flatMap((group) => {
                if (
                  group.repository.id !== data.buildConfiguration?.repository.id
                )
                  return [];
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
      {configuration ? (
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
                  href={`/codebases/repositories/${configuration.repository.id}`}
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
