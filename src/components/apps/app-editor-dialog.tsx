"use client";

import { FormEvent, useState } from "react";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { APP_FIELDS, type AppRepository, type ManagedApp } from "./types";

export function AppEditorDialog({
  app,
  open,
  onOpenChange,
  repositories,
  onSaved,
}: {
  app?: ManagedApp | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositories: AppRepository[];
  onSaved: (app: ManagedApp) => void | Promise<void>;
}) {
  const t = useTranslations("apps");
  const [name, setName] = useState(app?.name ?? "");
  const [description, setDescription] = useState(app?.description ?? "");
  const [repositoryIds, setRepositoryIds] = useState<Set<string>>(
    () => new Set(app?.repositories.map((repository) => repository.id) ?? []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const operation = app ? "updateApp" : "createApp";
      const data = await controlPlaneRequest<Record<string, ManagedApp>>(
        `mutation SaveApp($input: ${app ? "UpdateAppInput" : "CreateAppInput"}!) {
          ${operation}(input: $input) { ${APP_FIELDS} }
        }`,
        {
          input: {
            ...(app ? { id: app.id } : {}),
            name,
            description,
            repositoryIds: [...repositoryIds],
          },
        },
      );
      await onSaved(data[operation]!);
      onOpenChange(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={(next) => !busy && onOpenChange(next)} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <form className="space-y-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{app ? t("editApp") : t("createApp")}</DialogTitle>
            <DialogDescription>{t("editorDescription")}</DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="app-name">{t("name")}</Label>
            <Input
              autoFocus
              id="app-name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="app-description">{t("appDescription")}</Label>
            <Textarea
              id="app-description"
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              value={description}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("repositories")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("repositoryRequirement")}
            </p>
            <div className="max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">
              {repositories.map((repository) => {
                const checked = repositoryIds.has(repository.id);
                const inputId = `app-repository-${repository.id}`;
                return (
                  <div className="flex items-start gap-3" key={repository.id}>
                    <Checkbox
                      checked={checked}
                      id={inputId}
                      onCheckedChange={(value) =>
                        setRepositoryIds((current) => {
                          const next = new Set(current);
                          if (value === true) next.add(repository.id);
                          else next.delete(repository.id);
                          return next;
                        })
                      }
                    />
                    <Label className="min-w-0 flex-1" htmlFor={inputId}>
                      <span className="block">{repository.name}</span>
                      <span className="block truncate font-normal text-muted-foreground">
                        {repository.displayOrigin}
                      </span>
                    </Label>
                  </div>
                );
              })}
              {!repositories.length && (
                <p className="text-sm text-muted-foreground">
                  {t("noRepositoriesAvailable")}
                </p>
              )}
            </div>
          </fieldset>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !name.trim() || repositoryIds.size === 0}
              type="submit"
            >
              {busy ? <Spinner /> : <Save />}
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
