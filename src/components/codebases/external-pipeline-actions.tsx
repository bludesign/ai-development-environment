"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  externalPipelineContextFields,
  externalPipelineExampleContext,
  externalPipelineScriptExample,
} from "@/lib/external-pipeline-script-examples";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCredentialStoreReadOnly } from "@/hooks/use-credential-store-read-only";
const fields =
  "repositoryId enabled retryScript cancelScript secretNames updatedAt";
type Configuration = {
  repositoryId: string;
  enabled: boolean;
  retryScript: string;
  cancelScript: string;
  secretNames: string[];
};
export function ExternalPipelineActionsSettings({
  repositoryId,
}: {
  repositoryId: string;
}) {
  const t = useTranslations("externalPipelineActions");
  const [config, setConfig] = useState<Configuration>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>(),
    [notice, setNotice] = useState<string>();
  const [secretName, setSecretName] = useState(""),
    [secretValue, setSecretValue] = useState("");
  const credentialStore = useCredentialStoreReadOnly();
  useEffect(() => {
    let alive = true;
    void controlPlaneRequest<{ externalPipelineActions: Configuration }>(
      `query ExternalPipelineActions($repositoryId: ID!) { externalPipelineActions(repositoryId: $repositoryId) { ${fields} } }`,
      { repositoryId },
    )
      .then((data) => {
        if (alive) setConfig(data.externalPipelineActions);
      })
      .catch((value) => {
        if (alive) setError(String(value));
      });
    return () => {
      alive = false;
    };
  }, [repositoryId]);
  async function mutate(kind: "save" | "set" | "delete", name?: string) {
    if (!config || busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (kind === "save") {
        await controlPlaneRequest(
          `mutation SaveExternalPipelineActions($repositoryId: ID!, $input: ExternalPipelineActionsInput!) { saveExternalPipelineActions(repositoryId: $repositoryId, input: $input) { ${fields} } }`,
          {
            repositoryId,
            input: {
              enabled: config.enabled,
              retryScript: config.retryScript,
              cancelScript: config.cancelScript,
            },
          },
        );
      } else {
        const operation =
          kind === "set"
            ? "setExternalPipelineSecret"
            : "deleteExternalPipelineSecret";
        const data = await controlPlaneRequest<Record<string, Configuration>>(
          `mutation ExternalPipelineSecret($repositoryId: ID!, $name: String!${kind === "set" ? ", $value: String!" : ""}) { ${operation}(repositoryId: $repositoryId, name: $name${kind === "set" ? ", value: $value" : ""}) { ${fields} } }`,
          {
            repositoryId,
            name: name ?? secretName,
            ...(kind === "set" ? { value: secretValue } : {}),
          },
        );
        // Secret changes must not overwrite unsaved script edits.
        setConfig((previous) =>
          previous
            ? { ...previous, secretNames: data[operation].secretNames }
            : previous,
        );
        setSecretValue("");
        setSecretName("");
      }
      setNotice(t("saved"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  }
  if (!config) return <p>{error ?? t("loading")}</p>;
  return (
    <div className="space-y-5 rounded-lg border p-6">
      <div>
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && <p role="status">{notice}</p>}
      <Label>
        <Checkbox
          checked={config.enabled}
          disabled={busy}
          onCheckedChange={(enabled) =>
            setConfig({ ...config, enabled: enabled === true })
          }
        />
        {t("enabled")}
      </Label>
      <div className="space-y-2 text-sm">
        <h3 className="font-semibold">{t("entryPointTitle")}</h3>
        <p className="text-muted-foreground" id="externalScriptEntryPoint">
          {t("entryPointHelp")}
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          {(["retry", "cancel"] as const).map((action) => (
            <pre
              key={action}
              className="overflow-x-auto rounded-md bg-muted p-3"
            >
              <code>{`return await ${action}ExternalPipeline(context);`}</code>
            </pre>
          ))}
        </div>
        <p className="text-muted-foreground" id="externalScriptExampleHelp">
          {t("exampleHelp")}
        </p>
      </div>
      {(["retryScript", "cancelScript"] as const).map((key) => (
        <div className="space-y-2" key={key}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={key}>{t(key)}</Label>
            <div className="flex flex-wrap gap-2">
              {(["context", "http"] as const).map((example) => (
                <Button
                  key={example}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  aria-label={t(
                    example === "context"
                      ? "contextExampleFor"
                      : "httpExampleFor",
                    { script: t(key) },
                  )}
                  onClick={() => {
                    setConfig({
                      ...config,
                      [key]: externalPipelineScriptExample(
                        key === "retryScript" ? "retry" : "cancel",
                        example,
                      ),
                    });
                    setNotice(undefined);
                  }}
                >
                  {t(example === "context" ? "contextExample" : "httpExample")}
                </Button>
              ))}
            </div>
          </div>
          <Textarea
            id={key}
            aria-describedby="externalScriptEntryPoint externalScriptExampleHelp"
            className="min-h-48 font-mono"
            maxLength={100000}
            value={config[key]}
            disabled={busy}
            onChange={(event) =>
              setConfig({ ...config, [key]: event.target.value })
            }
            spellCheck={false}
          />
        </div>
      ))}
      <details className="space-y-3 rounded-md border p-3 text-sm">
        <summary className="cursor-pointer font-semibold">
          {t("contextReference")}
        </summary>
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_1fr]">
          {externalPipelineContextFields.map(([name, description]) => (
            <div key={name} className="contents">
              <dt className="font-mono">
                context.{name.replaceAll(", ", ", context.")}
              </dt>
              <dd className="text-muted-foreground">{t(description)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground">{t("contextHelp")}</p>
        <details>
          <summary className="cursor-pointer font-medium">
            {t("sampleContext")}
          </summary>
          <p className="my-2 text-muted-foreground">{t("sampleContextHelp")}</p>
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3">
            <code>
              {JSON.stringify(externalPipelineExampleContext, null, 2)}
            </code>
          </pre>
        </details>
      </details>
      <Button disabled={busy} onClick={() => void mutate("save")}>
        {t("save")}
      </Button>
      <div className="space-y-3">
        <h3 className="font-semibold">{t("secrets")}</h3>
        <p className="text-sm text-muted-foreground">{t("secretHelp")}</p>
        {config.secretNames.map((name) => (
          <div key={name} className="flex items-center gap-3">
            <code>{name}</code>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || credentialStore}
              onClick={() => setSecretName(name)}
            >
              {t("replace")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || credentialStore}
              onClick={() => void mutate("delete", name)}
            >
              {t("delete")}
            </Button>
          </div>
        ))}
        <Label htmlFor="externalSecretName">{t("secretName")}</Label>
        <Input
          id="externalSecretName"
          value={secretName}
          onChange={(event) => setSecretName(event.target.value)}
          disabled={busy || credentialStore}
        />
        <Label htmlFor="externalSecretValue">{t("secretValue")}</Label>
        <Input
          id="externalSecretValue"
          type="password"
          autoComplete="new-password"
          value={secretValue}
          onChange={(event) => setSecretValue(event.target.value)}
          disabled={busy || credentialStore}
        />
        <Button
          disabled={busy || credentialStore || !secretName || !secretValue}
          onClick={() => void mutate("set")}
        >
          {t("setSecret")}
        </Button>
      </div>
    </div>
  );
}
