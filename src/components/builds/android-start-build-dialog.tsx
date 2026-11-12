"use client";

import { Hammer } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  fetchAndroidAppProject,
  type AndroidAppProject,
} from "./android-project-section";
import { ConfigurationIcon } from "./configuration-icon";
import type { AndroidBuildConfiguration } from "./types";

export function AndroidStartBuildDialog({
  codebaseId,
  worktreeId,
  onClose,
  onStarted,
}: {
  codebaseId: string;
  worktreeId: string;
  onClose: () => void;
  onStarted?: (buildId: string) => void;
}) {
  const t = useTranslations("androidBuilds");
  const tc = useTranslations("common");
  const buildsT = useTranslations("builds");
  const [items, setItems] = useState<AndroidBuildConfiguration[]>([]);
  const [configurationId, setConfigurationId] = useState("");
  const [scripts, setScripts] = useState<
    NonNullable<AndroidAppProject["allowedScripts"]>
  >([]);
  const [scriptIds, setScriptIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<{
    key: string;
    requestId: string;
  } | null>(null);
  const configuration = items.find(({ id }) => id === configurationId);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAndroidAppProject(codebaseId, controller.signal).then(
      (project) => {
        if (controller.signal.aborted) return;
        const configurations = project?.androidConfigurations ?? [];
        setItems(configurations);
        setConfigurationId(configurations[0]?.id ?? "");
        const allowed = project?.allowedScripts ?? [];
        setScripts(allowed);
        setScriptIds(
          allowed
            .filter(({ script }) => script.enabledByDefault)
            .map(({ script }) => script.id),
        );
        setLoading(false);
      },
      (value) => {
        if (controller.signal.aborted) return;
        setError(String(value));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [codebaseId]);

  async function start() {
    if (busy || !configuration) return;
    setBusy(true);
    setError(null);
    try {
      const key = JSON.stringify([configuration.id, [...scriptIds].sort()]);
      if (submission.current?.key !== key) {
        submission.current = {
          key,
          requestId: createClientId(),
        };
      }
      const data = await controlPlaneRequest<{
        startAndroidBuild: {
          id: string;
          error: string | null;
          errorCode: string | null;
        };
      }>(
        `mutation StartAndroidBuild($input: StartAndroidBuildInput!) { startAndroidBuild(input: $input) { id error errorCode } }`,
        {
          input: {
            configurationId: configuration.id,
            requestId: submission.current.requestId,
            scriptIds,
            worktreeId,
          },
        },
      );
      const build = data.startAndroidBuild;
      if (build.errorCode === "QUEUE_FAILED") {
        submission.current = null;
        setError(build.error ?? t("startFailed"));
        return;
      }
      onStarted?.(build.id);
      onClose();
    } catch (value) {
      setError(String(value));
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
          <DialogTitle>{t("start")}</DialogTitle>
          <DialogDescription>{t("startDescription")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <Spinner />
        ) : items.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor="android-build-configuration">
              {t("configuration")}
            </Label>
            <Select
              disabled={busy}
              value={configurationId}
              onValueChange={setConfigurationId}
            >
              <SelectTrigger id="android-build-configuration">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map(({ id, name, iconKey }) => (
                  <SelectItem key={id} value={id}>
                    <ConfigurationIcon iconKey={iconKey} />
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {configuration && (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {configuration.projectPath} · {configuration.module} ·{" "}
                {configuration.variant}
              </p>
            )}
          </div>
        ) : (
          !error && (
            <p className="text-sm text-muted-foreground">
              {t("noConfigurations")}
            </p>
          )
        )}
        {scripts.length > 0 && (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="text-sm font-medium">
              {buildsT("scripts")}
            </legend>
            {scripts.map(({ script }) => (
              <label
                className="flex items-center gap-2 text-sm"
                key={script.id}
              >
                <Checkbox
                  checked={scriptIds.includes(script.id)}
                  onCheckedChange={(checked) => {
                    setScriptIds((current) =>
                      checked === true
                        ? [...current, script.id]
                        : current.filter((id) => id !== script.id),
                    );
                  }}
                />
                {script.name}
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            {tc("cancel")}
          </Button>
          <Button
            disabled={busy || !configuration}
            onClick={() => void start()}
            type="button"
          >
            {busy ? <Spinner /> : <Hammer />} {t("start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
