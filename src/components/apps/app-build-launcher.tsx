"use client";

import { Hammer } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useActiveAgent } from "@/components/active-agent/active-agent-provider";
import { StartBuildButton } from "@/components/builds/start-build-dialog";
import { BuildConfigurationLabel } from "@/components/builds/build-configuration-label";
import { OutOfDateBadge } from "@/components/builds/out-of-date-badge";
import { BUILD_LIST_FIELDS } from "@/components/builds/graphql-fields";
import { buildStatusVariant } from "@/components/builds/build-format";
import type { BuildRecord } from "@/components/builds/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateTime } from "@/components/common/date-time";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

type Worktree = {
  id: string;
  folder: string;
  branch: string | null;
  availability: string;
  codebaseId: string;
  agentId: string;
  agentName: string;
  enabled: boolean;
  repositoryId: string;
};
type Repository = {
  id: string;
  name: string;
  iosAppProject: { id: string } | null;
  latestBuild: BuildRecord | null;
};
type Data = {
  app: { repositories: Repository[] } | null;
  worktreeOverview: {
    agents: Array<{
      agent: {
        id: string;
        name: string;
        connectionStatus: string;
        capabilities: string[];
      };
      codebases: Array<{
        repository: { id: string };
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
};

export function AppBuildLauncher({ appId }: { appId: string }) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await controlPlaneRequest<Data>(
          `query AppBuildWorktrees($appId: ID!) {
        app(id: $appId) { repositories { id name iosAppProject { id } latestBuild { ${BUILD_LIST_FIELDS} } } }
        worktreeOverview(appId: $appId) { agents { agent { id name connectionStatus capabilities } codebases { repository { id } codebase { id } worktrees { id folder branch availability } } } }
      }`,
          { appId },
          { signal },
        );
        if (signal?.aborted) return;
        setRepositories(
          (data.app?.repositories ?? []).filter(
            (repository) => repository.iosAppProject,
          ),
        );
        setWorktrees(
          data.worktreeOverview.agents.flatMap(({ agent, codebases }) =>
            codebases.flatMap((group) =>
              group.worktrees.map((tree) => ({
                ...tree,
                codebaseId: group.codebase.id,
                repositoryId: group.repository.id,
                agentId: agent.id,
                agentName: agent.name,
                enabled:
                  agent.connectionStatus === "ONLINE" &&
                  agent.capabilities.includes("ios.build.run") &&
                  tree.availability === "AVAILABLE",
              })),
            ),
          ),
        );
        setError(null);
      } catch (error) {
        if (!signal?.aborted) setError(String(error));
      }
    },
    [appId],
  );
  useEffect(() => {
    const owner = createRefreshCoalescer(load);
    void owner.refresh();
    const disposers = [
      "subscription AppBuildCodebasesChanged { codebaseOverviewChanged { repositoryId } }",
      "subscription AppBuildWorktreesChanged { worktreeOverviewChanged { worktreeId } }",
      "subscription AppBuildHistoryChanged { buildsChanged { id } }",
      "subscription AppBuildAssignmentsChanged { appsChanged { id } }",
    ].map((query) =>
      controlPlaneSubscriptions().subscribe(
        { query },
        {
          next: () => void owner.refresh(),
          error: () => {},
          complete: () => {},
        },
      ),
    );
    const recover = onControlPlaneRecovery(() => void owner.refresh());
    return () => {
      owner.dispose();
      recover();
      disposers.forEach((dispose) => dispose());
    };
  }, [load]);
  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {repositories.map((repository) => (
          <RepositoryBuildCard
            key={repository.id}
            repository={repository}
            worktrees={worktrees.filter(
              (tree) => tree.repositoryId === repository.id,
            )}
            onCompleted={() => load()}
            onError={setError}
          />
        ))}
      </div>
    </div>
  );
}

function RepositoryBuildCard({
  repository,
  worktrees,
  onCompleted,
  onError,
}: {
  repository: Repository;
  worktrees: Worktree[];
  onCompleted: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const t = useTranslations("builds");
  const activeAgent = useActiveAgent();
  const [selectedId, setSelectedId] = useState("");
  const options = worktrees.filter(
    (tree) =>
      !activeAgent.activeAgentId || tree.agentId === activeAgent.activeAgentId,
  );
  const selected =
    options.find((tree) => tree.id === selectedId && tree.enabled) ??
    options.find((tree) => tree.enabled);
  const latest = repository.latestBuild;
  return (
    <Card data-build-repository={repository.id}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Hammer />
          {repository.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selected?.id ?? ""} onValueChange={setSelectedId}>
            <SelectTrigger
              className="min-w-48 flex-1"
              aria-label={t("worktree")}
            >
              <SelectValue placeholder={t("selectWorktree")} />
            </SelectTrigger>
            <SelectContent>
              {options.map((tree) => (
                <SelectItem
                  key={tree.id}
                  value={tree.id}
                  disabled={!tree.enabled}
                >
                  {tree.branch ?? tree.folder} · {tree.agentName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <StartBuildButton
            codebaseId={selected?.codebaseId ?? ""}
            worktreeId={selected?.id ?? ""}
            disabled={!selected}
            onStarted={() => void onCompleted()}
          />
        </div>
        {!selected && (
          <p className="text-sm text-muted-foreground">
            {t("noEligibleWorktrees")}
          </p>
        )}
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t("latestRepositoryBuild")}
          </p>
          {latest ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Link className="hover:underline" href={`/builds/${latest.id}`}>
                  <Badge variant={buildStatusVariant(latest.status)}>
                    {t(`statuses.${latest.status}`)}
                  </Badge>
                </Link>
                <Badge variant="outline">{t(`actions.${latest.action}`)}</Badge>
                {latest.outOfDate && (
                  <OutOfDateBadge
                    buildId={latest.id}
                    onCompleted={onCompleted}
                    onError={onError}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <BuildConfigurationLabel build={latest} />
                <span className="text-muted-foreground">
                  <DateTime value={latest.createdAt} />
                </span>
                <Link
                  className="ml-auto text-primary hover:underline"
                  href={`/builds/${latest.id}`}
                >
                  {t("viewBuild")}
                </Link>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("emptyTitle")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
