"use client";

import { canDeleteSimulator } from "@ai-development-environment/agent-contract/simulators";
import {
  ArrowLeft,
  Copy,
  FolderOpen,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { useActiveAgent } from "@/components/active-agent/active-agent-provider";
import {
  useBreadcrumbFallback,
  useBreadcrumbLabel,
} from "@/components/breadcrumb-labels-provider";
import { DetailItem, DetailList } from "@/components/common/detail-list";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, useRouter } from "@/i18n/navigation";
import { copyText } from "@/lib/browser-utils";

import {
  inspectSimulator,
  performSimulatorAction,
  simulatorAgentSupports,
  type SimulatorAction,
  type SimulatorActionInput,
  type SimulatorDetails,
} from "./simulator-client";
import { SimulatorStateBadge } from "./simulator-state-badge";

type NamedAction = "RENAME" | "CLONE";
type DestructiveAction = "ERASE" | "DELETE";

export function SimulatorDetailPage({
  agentId,
  simulatorId,
}: {
  agentId: string;
  simulatorId: string;
}) {
  const t = useTranslations("simulators");
  const tc = useTranslations("common");
  const router = useRouter();
  const { agents } = useActiveAgent();
  const agent = agents.find(({ id }) => id === agentId);
  const agentName = agent?.name ?? t("owningAgent");
  const [details, setDetails] = useState<SimulatorDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [destructive, setDestructive] = useState<DestructiveAction | null>(
    null,
  );
  const [named, setNamed] = useState<NamedAction | null>(null);
  const loadRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const simulator = details?.simulator;
  const canAct = Boolean(
    agent &&
    simulatorAgentSupports(agent, "action") &&
    !loading &&
    !loadError &&
    !busy,
  );
  const booted = simulator?.state.toLowerCase() === "booted";
  const shutDown = simulator?.state.toLowerCase() === "shutdown";
  const deletable = Boolean(simulator && canDeleteSimulator(simulator));

  useBreadcrumbLabel(["system", "simulators", agentId], agent?.name);
  useBreadcrumbFallback(["system", "simulators", agentId], !loading && !agent);
  useBreadcrumbLabel(
    ["system", "simulators", agentId, simulator?.id],
    simulator?.name,
  );
  useBreadcrumbFallback(
    ["system", "simulators", agentId, simulatorId],
    Boolean(loadError),
  );

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    setLoading(true);
    try {
      const value = await inspectSimulator(
        agentId,
        simulatorId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDetails(value);
      setLoadError(null);
    } catch (value) {
      if (!controller.signal.aborted)
        setLoadError(value instanceof Error ? value.message : String(value));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [agentId, simulatorId, setLoading, setDetails, setLoadError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      loadRequest.current?.abort();
      actionRequest.current?.abort();
    };
  }, [load]);

  async function run(
    action: SimulatorAction,
    input?: Pick<SimulatorActionInput, "name" | "bundleId">,
  ) {
    if (!canAct) return false;
    const controller = new AbortController();
    actionRequest.current = controller;
    setActionError(null);
    setNotice(null);
    setBusy(true);
    const inspectAfter = !action.startsWith("OPEN_");
    try {
      await performSimulatorAction(
        { agentId, simulatorId, action, ...input },
        controller.signal,
      );
      if (controller.signal.aborted) return false;
      if (action === "DELETE") router.push("/system/simulators");
      else if (inspectAfter) await load();
      else setNotice(t("finderOpened", { agent: agentName }));
      return true;
    } catch (value) {
      if (!controller.signal.aborted) {
        if (inspectAfter) await load();
        if (!controller.signal.aborted)
          setActionError(
            value instanceof Error ? value.message : String(value),
          );
      }
      return false;
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function copyPath(path: string) {
    setActionError(null);
    setNotice(null);
    try {
      await copyText(path);
      setNotice(t("pathCopied"));
    } catch {
      setActionError(t("copyFailed"));
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Button asChild className="-ml-2 mb-2" size="sm" variant="ghost">
            <Link href="/system/simulators">
              <ArrowLeft /> {t("title")}
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight wrap-anywhere">
            {simulator?.name ?? t("detailTitle")}
          </h1>
          {simulator && (
            <p className="mt-1 text-sm text-muted-foreground">
              {simulator.runtimeName ?? simulator.platform} · {agentName}
            </p>
          )}
        </div>
        <Button
          disabled={loading || busy}
          onClick={() => void load()}
          variant="outline"
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />{" "}
          {t("refresh")}
        </Button>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      )}
      {loading && (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner /> {t("loadingDetails")}
        </p>
      )}

      {details && simulator && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("deviceInformation")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <DetailList className="sm:grid-cols-2 lg:grid-cols-3">
                <DetailItem label={t("state")}>
                  <SimulatorStateBadge simulator={simulator} />
                </DetailItem>
                <DetailItem label={t("platform")}>
                  {simulator.platform}
                </DetailItem>
                <DetailItem label={t("runtime")}>
                  {simulator.runtimeName ?? simulator.runtimeId}
                </DetailItem>
                <DetailItem label={t("agent")}>
                  <Link
                    className="underline-offset-4 hover:underline"
                    href={`/dashboard/agents/${encodeURIComponent(agentId)}`}
                  >
                    {agentName}
                  </Link>
                </DetailItem>
                <DetailItem label={t("deviceType")} mono>
                  {simulator.deviceTypeId?.replace(
                    /^com\.apple\.CoreSimulator\.SimDeviceType\./,
                    "",
                  ) ?? "—"}
                </DetailItem>
                <DetailItem label={t("identifier")} mono>
                  {simulator.id}
                </DetailItem>
                {simulator.dataPath && (
                  <DetailItem
                    className="sm:col-span-2 lg:col-span-3"
                    label={t("dataFolder")}
                    mono
                  >
                    {simulator.dataPath}
                  </DetailItem>
                )}
              </DetailList>
              {simulator.availabilityError && (
                <p className="text-sm text-muted-foreground">
                  {simulator.availabilityError}
                </p>
              )}
              {simulator.dataPath && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!canAct}
                    onClick={() => void run("OPEN_DATA_FOLDER")}
                    size="sm"
                    variant="outline"
                  >
                    <FolderOpen /> {t("openInFinder", { agent: agentName })}
                  </Button>
                  <Button
                    onClick={() => void copyPath(simulator.dataPath!)}
                    size="sm"
                    variant="outline"
                  >
                    <Copy /> {t("copyPath")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("controls")}</CardTitle>
              <CardDescription>
                {t("controlsDescription", { agent: agentName })}
                {!deletable && <> {t("deleteNeedsShutdown")}</>}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {busy && <Spinner className="self-center" />}
              <Button
                disabled={!canAct || !simulator.isAvailable || !shutDown}
                onClick={() => void run("BOOT")}
                variant="outline"
              >
                {t("boot")}
              </Button>
              <Button
                disabled={!canAct || !simulator.isAvailable || !booted}
                onClick={() => void run("SHUTDOWN")}
                variant="outline"
              >
                {t("shutdown")}
              </Button>
              <Button
                disabled={!canAct || !simulator.isAvailable || !booted}
                onClick={() => void run("REBOOT")}
                variant="outline"
              >
                {t("reboot")}
              </Button>
              <Button
                disabled={
                  !canAct || !simulator.isAvailable || (!booted && !shutDown)
                }
                onClick={() => setNamed("RENAME")}
                variant="outline"
              >
                {t("rename")}
              </Button>
              <Button
                disabled={!canAct || !simulator.isAvailable || !shutDown}
                onClick={() => setNamed("CLONE")}
                variant="outline"
              >
                {t("clone")}
              </Button>
              <Button
                disabled={!canAct || !simulator.isAvailable || !shutDown}
                onClick={() => setDestructive("ERASE")}
                variant="outline"
              >
                {t("erase")}
              </Button>
              <Button
                disabled={!canAct || !deletable}
                onClick={() => setDestructive("DELETE")}
                variant="destructive"
              >
                {t("delete")}
              </Button>
            </CardContent>
          </Card>

          <Card className="gap-0 pb-0">
            <CardHeader>
              <CardTitle>{t("installedApps")}</CardTitle>
              <CardDescription>{t("appsDescription")}</CardDescription>
            </CardHeader>
            {!booted || details.apps.length === 0 ? (
              <CardContent className="py-(--card-spacing) text-muted-foreground">
                {t(
                  !simulator.isAvailable
                    ? "appsUnavailable"
                    : booted
                      ? "noApps"
                      : "bootForApps",
                )}
              </CardContent>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("app")}</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      {t("appVersion")}
                    </TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">{t("actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...details.apps]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((app) => (
                      <TableRow key={app.bundleId}>
                        <TableCell className="whitespace-normal">
                          <p className="font-medium">{app.name}</p>
                          <p className="font-mono text-xs break-all text-muted-foreground">
                            {app.bundleId}
                          </p>
                          {(app.version || app.build) && (
                            <p className="text-xs text-muted-foreground sm:hidden">
                              {[app.version, app.build]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {[app.version, app.build]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                aria-label={t("actionsFor", { name: app.name })}
                                size="icon-sm"
                                variant="ghost"
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={!canAct}
                                onSelect={() =>
                                  void run("LAUNCH_APP", {
                                    bundleId: app.bundleId,
                                  })
                                }
                              >
                                {t("launchApp")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={!canAct}
                                onSelect={() =>
                                  void run("TERMINATE_APP", {
                                    bundleId: app.bundleId,
                                  })
                                }
                              >
                                {t("terminateApp")}
                              </DropdownMenuItem>
                              {(app.bundlePath || app.dataPath) && (
                                <DropdownMenuSeparator />
                              )}
                              {app.bundlePath && (
                                <>
                                  <DropdownMenuItem
                                    disabled={!canAct}
                                    onSelect={() =>
                                      void run("OPEN_APP_BUNDLE_FOLDER", {
                                        bundleId: app.bundleId,
                                      })
                                    }
                                  >
                                    {t("revealAppBundle", { agent: agentName })}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      void copyPath(app.bundlePath!)
                                    }
                                  >
                                    {t("copyAppBundlePath")}
                                  </DropdownMenuItem>
                                </>
                              )}
                              {app.dataPath && (
                                <>
                                  <DropdownMenuItem
                                    disabled={!canAct}
                                    onSelect={() =>
                                      void run("OPEN_APP_DATA_FOLDER", {
                                        bundleId: app.bundleId,
                                      })
                                    }
                                  >
                                    {t("openAppData", { agent: agentName })}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onSelect={() =>
                                      void copyPath(app.dataPath!)
                                    }
                                  >
                                    {t("copyAppDataPath")}
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            )}
          </Card>

          {destructive && (
            <ConfirmationDialog
              actionLabel={t(destructive === "DELETE" ? "delete" : "erase")}
              cancelLabel={tc("cancel")}
              description={t(
                destructive === "DELETE"
                  ? "deleteDescription"
                  : "eraseDescription",
                { name: simulator.name, agent: agentName },
              )}
              onConfirm={async () => {
                await run(destructive);
              }}
              onOpenChange={(open) => {
                if (!open) setDestructive(null);
              }}
              open
              title={t(destructive === "DELETE" ? "deleteTitle" : "eraseTitle")}
            />
          )}
          {named && (
            <SimulatorNameDialog
              action={named}
              currentName={simulator.name}
              onClose={() => setNamed(null)}
              onSubmit={(name) => run(named, { name })}
            />
          )}
        </>
      )}
    </section>
  );
}

function SimulatorNameDialog({
  action,
  currentName,
  onClose,
  onSubmit,
}: {
  action: NamedAction;
  currentName: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const t = useTranslations("simulators");
  const tc = useTranslations("common");
  const renaming = action === "RENAME";
  const [name, setName] = useState(renaming ? currentName : "");
  const [busy, setBusy] = useState(false);
  const valid = name.trim() && (!renaming || name.trim() !== currentName);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onSubmit(name.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(renaming ? "rename" : "clone")}</DialogTitle>
          <DialogDescription>
            {t(renaming ? "renameDescription" : "cloneDescription", {
              name: currentName,
            })}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-1.5">
            <Label htmlFor="simulator-name">{t("name")}</Label>
            <Input
              disabled={busy}
              id="simulator-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={onClose}
              type="button"
              variant="outline"
            >
              {tc("cancel")}
            </Button>
            <Button disabled={busy || !valid} type="submit">
              {busy && <Spinner />}
              {t(renaming ? "rename" : "clone")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
