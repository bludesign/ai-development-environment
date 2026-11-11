import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import type { ActiveAgentOption } from "@/components/active-agent/active-agent-provider";
import { SearchableSelect } from "@/components/common/searchable-select";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

import type {
  CreateSimulatorInput,
  SimulatorInventory,
  SimulatorPlatform,
} from "./simulator-client";

export function SimulatorFleetDialog({
  agents,
  inventories,
  mode,
  platform = "APPLE",
  onClose,
  onCreate,
  onReset,
}: {
  agents: ActiveAgentOption[];
  inventories: Record<string, SimulatorInventory>;
  mode: "create" | "reset";
  platform?: SimulatorPlatform;
  onClose: () => void;
  onCreate: (input: CreateSimulatorInput) => Promise<void>;
  onReset: (agentId: string) => Promise<void>;
}) {
  const t = useTranslations("simulators");
  const tc = useTranslations("common");
  const [agentId, setAgentId] = useState(
    agents.length === 1 ? agents[0]!.id : "",
  );
  const [runtimeId, setRuntimeId] = useState("");
  const [deviceTypeId, setDeviceTypeId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = agents.find(({ id }) => id === agentId);
  const runtimes = agent ? (inventories[agent.id]?.runtimes ?? []) : [];
  const runtime = runtimes.find(({ id }) => id === runtimeId);
  const deviceType = runtime?.deviceTypes.find(({ id }) => id === deviceTypeId);
  const creating = mode === "create";
  const android = platform === "ANDROID";
  const defaultName = android
    ? deviceType?.name.replace(/[^a-zA-Z0-9_.-]+/g, "_")
    : deviceType?.name;
  const canReset = !inventories[agentId]?.simulators.some(
    ({ state }) => state.toLowerCase() !== "shutdown",
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent || busy || (!creating && !canReset)) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        if (!runtime || !deviceType) return;
        await onCreate({
          agentId,
          runtimeId,
          deviceTypeId,
          name: name.trim() || defaultName || deviceType.id,
          ...(android ? { platform } : {}),
        });
      } else {
        await onReset(agentId);
      }
      onClose();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }

  const selectorText = {
    searchPlaceholder: t("searchOptions"),
    emptyMessage: t("noOptions"),
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(
              creating ? (android ? "createEmulator" : "create") : "resetTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {creating
              ? t("createDescription")
              : t("resetDescription", {
                  agent: agent?.name ?? t("selectedAgent"),
                })}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t("agent")}</p>
            <SearchableSelect
              {...selectorText}
              ariaLabel={t("agent")}
              disabled={
                busy || !agents.length || (agents.length === 1 && !!agent)
              }
              onValueChange={(id) => {
                setAgentId(id);
                setRuntimeId("");
                setDeviceTypeId("");
              }}
              options={agents.map(({ id, name, hostname }) => ({
                value: id,
                label: name,
                keywords: hostname,
              }))}
              placeholder={t("selectAgent")}
              value={agent?.id ?? ""}
            />
          </div>
          {creating && (
            <>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t("runtime")}</p>
                <SearchableSelect
                  {...selectorText}
                  ariaLabel={t("runtime")}
                  disabled={busy || !agent}
                  onValueChange={(id) => {
                    setRuntimeId(id);
                    setDeviceTypeId("");
                  }}
                  options={runtimes.map(({ id, name }) => ({
                    value: id,
                    label: name,
                    keywords: id,
                  }))}
                  placeholder={t("selectRuntime")}
                  value={runtimeId}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t("deviceType")}</p>
                <SearchableSelect
                  {...selectorText}
                  ariaLabel={t("deviceType")}
                  disabled={busy || !runtime}
                  onValueChange={setDeviceTypeId}
                  options={(runtime?.deviceTypes ?? []).map(({ id, name }) => ({
                    value: id,
                    label: name,
                  }))}
                  placeholder={t("selectDeviceType")}
                  value={deviceTypeId}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="create-simulator-name">{t("name")}</Label>
                <Input
                  disabled={busy}
                  id="create-simulator-name"
                  maxLength={android ? 80 : 120}
                  pattern={
                    android ? "[A-Za-z0-9][A-Za-z0-9._\\-]{0,79}" : undefined
                  }
                  onChange={(event) => setName(event.target.value)}
                  placeholder={defaultName}
                  value={name}
                />
              </div>
            </>
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
              disabled={busy || !agent || (creating ? !deviceType : !canReset)}
              type="submit"
              variant={creating ? "default" : "destructive"}
            >
              {busy && <Spinner />}
              {t(creating ? (android ? "createEmulator" : "create") : "reset")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
