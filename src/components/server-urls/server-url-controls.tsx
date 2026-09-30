"use client";
import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useServerUrlSettings } from "@/hooks/use-server-url-settings";
import { Link } from "@/i18n/navigation";
import { copyText } from "@/lib/browser-utils";
import {
  serverUrlOptions,
  serverUrlActionProblem,
  type ServerUrlKind,
  type ServerUrlSettings,
} from "@/lib/server-urls";

export function ServerUrlSelect({
  settings,
  value,
  onValueChange,
  id,
  inherit = false,
}: {
  settings: ServerUrlSettings;
  value: ServerUrlKind | "INHERIT";
  onValueChange: (kind: ServerUrlKind | "INHERIT") => void;
  id?: string;
  inherit?: boolean;
}) {
  const t = useTranslations("serverUrls");
  const selected = serverUrlOptions(settings).find(
    (option) => option.kind === value,
  );
  return (
    <Select
      value={value}
      onValueChange={(kind) => onValueChange(kind as ServerUrlKind | "INHERIT")}
    >
      <SelectTrigger
        id={id}
        aria-label={t("serverUrl")}
        className="h-auto min-h-12 w-full text-left"
      >
        <SelectValue>
          <span className="flex min-w-0 flex-col">
            <span>
              {value === "INHERIT"
                ? t("inherit")
                : t(value.toLowerCase() as "local")}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {selected?.url ??
                (value === "INHERIT"
                  ? serverUrlOptions(settings).find(
                      (option) => option.kind === settings.defaultServerUrlKind,
                    )?.url
                  : t("proxyMissing"))}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {inherit && <SelectItem value="INHERIT">{t("inherit")}</SelectItem>}
        {serverUrlOptions(settings).map((option) => (
          <SelectItem
            key={option.kind}
            value={option.kind}
            textValue={t(option.kind.toLowerCase() as "local")}
          >
            <span className="flex min-w-0 flex-col">
              <span>{t(option.kind.toLowerCase() as "local")}</span>
              <span className="break-all text-xs text-muted-foreground">
                {option.url}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ServerUrlActionNotice({
  kind,
  publicHost = false,
}: {
  kind: ServerUrlKind | null;
  publicHost?: boolean;
}) {
  const { settings } = useServerUrlSettings();
  const t = useTranslations("serverUrls");
  const problem = serverUrlActionProblem(settings, kind, publicHost);
  return problem ? (
    <p role="status" className="text-xs text-muted-foreground">
      {t(problem)}
    </p>
  ) : null;
}

export function ServerUrlPicker({
  value,
  onValueChange,
}: {
  value: ServerUrlKind | null;
  onValueChange: (kind: ServerUrlKind) => void;
}) {
  const { settings, error } = useServerUrlSettings();
  const t = useTranslations("serverUrls");
  return (
    <div className="space-y-2">
      {settings ? (
        <ServerUrlSelect
          settings={settings}
          value={value ?? settings.defaultServerUrlKind}
          onValueChange={(kind) => {
            if (kind !== "INHERIT") onValueChange(kind);
          }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">{error ?? t("loading")}</p>
      )}
      {settings && value === "PROXY" && !settings.proxyBaseUrl && (
        <p role="alert" className="text-xs text-destructive">
          {t("proxyMissing")}
        </p>
      )}
      <ServerUrlSettingsLink />
    </div>
  );
}

export function ServerUrlSettingsLink() {
  const t = useTranslations("serverUrls");
  return (
    <Link
      className="text-xs text-primary underline underline-offset-4"
      href="/settings#server-urls"
    >
      {t("manage")}
    </Link>
  );
}

export function EndpointUrls({ path }: { path: string }) {
  const { settings, error } = useServerUrlSettings();
  const t = useTranslations("serverUrls");
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  return (
    <div className="min-w-0 space-y-2">
      {settings ? (
        serverUrlOptions(settings).map((option) => (
          <div className="flex min-w-0 items-start gap-2" key={option.kind}>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium">
                {t("endpoint", {
                  name: t(option.kind.toLowerCase() as "local"),
                })}
              </p>
              <code className="block break-all text-xs text-muted-foreground">
                {option.url + path}
              </code>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("copyEndpoint", {
                name: t(option.kind.toLowerCase() as "local"),
              })}
              onClick={() => {
                void copyText(option.url + path)
                  .then(() => {
                    setCopied(option.kind);
                    setCopyError(null);
                  })
                  .catch(() => setCopyError(t("copyFailed")));
              }}
            >
              <Copy />
            </Button>
            {copied === option.kind && (
              <span className="sr-only" role="status">
                {t("copied")}
              </span>
            )}
          </div>
        ))
      ) : (
        <p className="text-xs text-muted-foreground">{error ?? t("loading")}</p>
      )}
      {copyError && (
        <p role="alert" className="text-xs text-destructive">
          {copyError}
        </p>
      )}
      <ServerUrlSettingsLink />
    </div>
  );
}
