"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useOwnedRead } from "@/hooks/use-owned-read";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  CRASH_SETTINGS_QUERY,
  UPDATE_CRASH_SETTINGS_MUTATION,
} from "./graphql";
import type { CrashSettings, CrashSymbolicationAgent } from "./types";

const ANY_AGENT = "any";

export function CrashSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("crashes");
  const [agents, setAgents] = useState<CrashSymbolicationAgent[]>([]);
  const [collectionEnabled, setCollectionEnabled] = useState(true);
  const [agentId, setAgentId] = useState(ANY_AGENT);
  const [retentionDays, setRetentionDays] = useState("90");
  const [dsymRetentionDays, setDsymRetentionDays] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        crashSettings: CrashSettings;
        crashSymbolicationAgents: CrashSymbolicationAgent[];
      }>(CRASH_SETTINGS_QUERY, undefined, { signal });
      if (signal.aborted) return;
      setAgents(data.crashSymbolicationAgents);
      setCollectionEnabled(data.crashSettings.collectionEnabled);
      setAgentId(data.crashSettings.symbolicationAgentId ?? ANY_AGENT);
      setRetentionDays(String(data.crashSettings.retentionDays));
      setDsymRetentionDays(
        data.crashSettings.dsymRetentionDays === null
          ? ""
          : String(data.crashSettings.dsymRetentionDays),
      );
    } catch (value) {
      if (!signal.aborted) {
        setError(value instanceof Error ? value.message : String(value));
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);
  useOwnedRead(fetchData, { enabled: open });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await controlPlaneRequest(UPDATE_CRASH_SETTINGS_MUTATION, {
        input: {
          collectionEnabled,
          symbolicationAgentId: agentId === ANY_AGENT ? null : agentId,
          retentionDays: Number(retentionDays),
          dsymRetentionDays: dsymRetentionDays.trim()
            ? Number(dsymRetentionDays)
            : null,
        },
      });
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  const noAgents = !loading && agents.length === 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settingsTitle")}</DialogTitle>
          <DialogDescription>{t("settingsDescription")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : (
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="crash-collection">
                  {t("collectionEnabled")}
                </FieldLabel>
                <FieldDescription>
                  {t("collectionEnabledDescription")}
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={collectionEnabled}
                id="crash-collection"
                onCheckedChange={setCollectionEnabled}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="crash-agent">
                {t("symbolicationAgent")}
              </FieldLabel>
              <Select onValueChange={setAgentId} value={agentId}>
                <SelectTrigger id="crash-agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_AGENT}>{t("anyMacAgent")}</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                      {agent.online ? "" : ` (${t("offline")})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {noAgents
                  ? t("noSymbolicationAgents")
                  : t("symbolicationAgentDescription")}
              </FieldDescription>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="crash-retention">
                  {t("crashRetention")}
                </FieldLabel>
                <Input
                  id="crash-retention"
                  inputMode="numeric"
                  max={3650}
                  min={1}
                  onChange={(event) => setRetentionDays(event.target.value)}
                  type="number"
                  value={retentionDays}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="dsym-retention">
                  {t("dsymRetention")}
                </FieldLabel>
                <Input
                  id="dsym-retention"
                  inputMode="numeric"
                  max={3650}
                  min={1}
                  onChange={(event) => setDsymRetentionDays(event.target.value)}
                  placeholder={t("keepForever")}
                  type="number"
                  value={dsymRetentionDays}
                />
              </Field>
            </div>
          </FieldGroup>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
          <Button disabled={loading || saving} onClick={() => void save()}>
            {saving ? <Spinner /> : null}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
