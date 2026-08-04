"use client";

import { Hammer } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { StartBuildButton } from "@/components/builds/start-build-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type BuildWorktree = {
  id: string;
  folder: string;
  branch: string | null;
  availability: string;
  codebaseId: string;
  repositoryName: string;
  enabled: boolean;
};

export function AppBuildLauncher({ appId }: { appId: string }) {
  const t = useTranslations("apps");
  const [items, setItems] = useState<BuildWorktree[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        worktreeOverview: {
          agents: Array<{
            agent: { connectionStatus: string; capabilities: string[] };
            codebases: Array<{
              iosBuildConfigured: boolean;
              repository: { name: string };
              codebase: { id: string };
              worktrees: Array<{
                id: string;
                folder: string;
                branch: string | null;
                availability: string;
              }>;
            }>;
          }>;
        };
      }>(
        `query AppBuildWorktrees($appId: ID!) {
          worktreeOverview(appId: $appId) {
            agents {
              agent { connectionStatus capabilities }
              codebases {
                iosBuildConfigured
                repository { name }
                codebase { id }
                worktrees { id folder branch availability }
              }
            }
          }
        }`,
        { appId },
      );
      const next = data.worktreeOverview.agents.flatMap(
        ({ agent, codebases }) =>
          codebases.flatMap((codebase) =>
            codebase.worktrees.map((worktree) => ({
              ...worktree,
              codebaseId: codebase.codebase.id,
              repositoryName: codebase.repository.name,
              enabled:
                agent.connectionStatus === "ONLINE" &&
                agent.capabilities.includes("ios.build.run") &&
                codebase.iosBuildConfigured &&
                worktree.availability === "AVAILABLE",
            })),
          ),
      );
      setItems(next);
      setSelectedId((current) =>
        next.some((item) => item.id === current)
          ? current
          : (next.find((item) => item.enabled)?.id ?? ""),
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [appId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId),
    [items, selectedId],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hammer /> {t("startBuild")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        {error && (
          <Alert className="w-full" variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="min-w-64 flex-1">
          <Select
            onValueChange={(value) => setSelectedId(value ?? "")}
            value={selectedId}
          >
            <SelectTrigger aria-label={t("buildWorktree")} className="w-full">
              <SelectValue placeholder={t("selectBuildWorktree")} />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem
                  disabled={!item.enabled}
                  key={item.id}
                  value={item.id}
                >
                  {item.repositoryName} · {item.branch ?? item.folder}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {selected && (
          <StartBuildButton
            codebaseId={selected.codebaseId}
            disabled={!selected.enabled}
            size="default"
            worktreeId={selected.id}
          />
        )}
      </CardContent>
    </Card>
  );
}
