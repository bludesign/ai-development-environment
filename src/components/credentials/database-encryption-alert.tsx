"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type Props = {
  warningCodes?: string[];
};

export function DatabaseEncryptionAlert({ warningCodes }: Props) {
  const t = useTranslations("credentialEncryption");
  const [loadedCodes, setLoadedCodes] = useState<string[] | null>(
    warningCodes ?? null,
  );

  useEffect(() => {
    if (warningCodes !== undefined) return;
    let cancelled = false;
    void controlPlaneRequest<{
      credentialStoreStatus: { warnings: Array<{ code: string }> };
    }>(
      `query CredentialEncryptionWarning {
        credentialStoreStatus { warnings { code } }
      }`,
    )
      .then((data) => {
        if (!cancelled) {
          setLoadedCodes(
            data.credentialStoreStatus.warnings.map((warning) => warning.code),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [warningCodes]);

  const effectiveCodes = warningCodes ?? loadedCodes;
  if (!effectiveCodes?.includes("DATABASE_UNENCRYPTED")) return null;

  return (
    <Alert className="border-amber-500/40 bg-amber-500/10">
      <TriangleAlert />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t("description")}</p>
        <pre className="overflow-x-auto rounded-md border bg-background px-3 py-2 text-xs">
          <code>openssl rand -base64 32</code>
        </pre>
        <p>
          {t("instructionsPrefix")} <code>CREDENTIAL_ENCRYPTION_KEY</code>{" "}
          {t("instructionsSuffix")}
        </p>
        <p className="font-medium">{t("backup")}</p>
      </AlertDescription>
    </Alert>
  );
}
