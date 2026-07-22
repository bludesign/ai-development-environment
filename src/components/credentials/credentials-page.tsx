"use client";

import { KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { DatabaseEncryptionAlert } from "./database-encryption-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { controlPlaneRequest } from "@/lib/control-plane-client";

type StoreStatus = {
  storageType: "DATABASE" | "VAULT" | "KEYCHAIN" | "UNKNOWN";
  state: "READY" | "WARNING" | "ERROR";
  encryptionState: "ENCRYPTED" | "PLAINTEXT" | "EXTERNAL" | "ERROR";
  details: Array<{ label: string; value: string }>;
  itemCount: number;
  mismatchCount: number;
  warnings: Array<{ code: string; message: string }>;
};

type CredentialItem = {
  id: string;
  kind: string;
  ownerId: string | null;
  ownerFeature: string;
  storageType: "DATABASE" | "VAULT" | "KEYCHAIN" | "UNKNOWN";
  protection: "ENCRYPTED" | "PLAINTEXT" | "VAULT" | "KEYCHAIN";
  createdAt: string;
  updatedAt: string;
};

type CredentialsData = {
  credentialStoreStatus: StoreStatus;
  credentials: CredentialItem[];
};

const QUERY = `query CredentialsInventory {
  credentialStoreStatus {
    storageType state encryptionState itemCount mismatchCount
    details { label value }
    warnings { code message }
  }
  credentials {
    id kind ownerId ownerFeature storageType protection createdAt updatedAt
  }
}`;

const detailKeys: Record<string, string> = {
  "Configured value": "configuredValue",
  Location: "location",
  "Encryption key": "encryptionKey",
  Service: "service",
  "Host platform": "hostPlatform",
  Address: "address",
  "KV v2 mount": "mount",
  "Path prefix": "pathPrefix",
  Namespace: "namespace",
  "Authentication token": "authenticationToken",
  "Additional headers": "additionalHeaders",
  "Custom CA": "customCa",
  "TLS server name": "tlsServerName",
};

const valueKeys: Record<string, string> = {
  Configured: "configured",
  "Not configured": "notConfigured",
  None: "none",
  Invalid: "invalid",
  "Application database": "applicationDatabase",
};

export function CredentialsPage() {
  const t = useTranslations("credentials");
  const locale = useLocale();
  const [data, setData] = useState<CredentialsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await controlPlaneRequest<CredentialsData>(QUERY));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void controlPlaneRequest<CredentialsData>(QUERY)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((value: unknown) => {
        if (!cancelled) {
          setError(value instanceof Error ? value.message : String(value));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const warningCodes =
    data?.credentialStoreStatus.warnings.map((warning) => warning.code) ?? [];
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          disabled={loading}
          onClick={() => void load()}
          variant="outline"
        >
          {loading ? <Spinner /> : <RefreshCw />}
          {t("refresh")}
        </Button>
      </div>

      <DatabaseEncryptionAlert warningCodes={warningCodes} />

      {error && (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>{t("loadFailed")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("storageTitle")}</CardTitle>
              <CardDescription>{t("storageDescription")}</CardDescription>
              <CardAction>
                <Badge variant={stateVariant(data.credentialStoreStatus.state)}>
                  {t(`states.${data.credentialStoreStatus.state}`)}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Summary label={t("backend")}>
                  {t(`backends.${data.credentialStoreStatus.storageType}`)}
                </Summary>
                <Summary label={t("protection")}>
                  {t(
                    `encryptionStates.${data.credentialStoreStatus.encryptionState}`,
                  )}
                </Summary>
                <Summary label={t("itemCount")}>
                  {data.credentialStoreStatus.itemCount}
                </Summary>
                <Summary label={t("mismatchCount")}>
                  {data.credentialStoreStatus.mismatchCount}
                </Summary>
              </div>
              <dl className="grid gap-x-8 gap-y-3 border-t pt-4 md:grid-cols-2">
                {data.credentialStoreStatus.details.map((detail) => (
                  <div className="min-w-0" key={detail.label}>
                    <dt className="text-xs font-medium text-muted-foreground">
                      {detailKeys[detail.label]
                        ? t(`details.${detailKeys[detail.label]}`)
                        : detail.label}
                    </dt>
                    <dd className="mt-1 break-words font-mono text-xs">
                      {valueKeys[detail.value]
                        ? t(`detailValues.${valueKeys[detail.value]}`)
                        : detail.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          {data.credentialStoreStatus.warnings
            .filter((warning) => warning.code !== "DATABASE_UNENCRYPTED")
            .map((warning) => (
              <Alert
                key={warning.code}
                variant={
                  data.credentialStoreStatus.state === "ERROR"
                    ? "destructive"
                    : "default"
                }
              >
                <ShieldAlert />
                <AlertTitle>{t(`warningTitles.${warning.code}`)}</AlertTitle>
                <AlertDescription>
                  {warning.code === "BACKEND_MISMATCH"
                    ? t("warnings.BACKEND_MISMATCH", {
                        count: data.credentialStoreStatus.mismatchCount,
                      })
                    : t(`warnings.${warning.code}`)}
                </AlertDescription>
              </Alert>
            ))}

          <Card>
            <CardHeader>
              <CardTitle>{t("inventoryTitle")}</CardTitle>
              <CardDescription>{t("inventoryDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {data.credentials.length ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("feature")}</TableHead>
                        <TableHead>{t("kind")}</TableHead>
                        <TableHead>{t("backend")}</TableHead>
                        <TableHead>{t("protection")}</TableHead>
                        <TableHead>{t("updated")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.credentials.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            <div className="font-medium">
                              {featureName(t, item.kind, item.ownerFeature)}
                            </div>
                            {item.ownerId && item.ownerId !== "default" && (
                              <div className="font-mono text-xs text-muted-foreground">
                                {item.ownerId}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>{kindName(t, item.kind)}</TableCell>
                          <TableCell>
                            {t(`backends.${item.storageType}`)}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {t(`protections.${item.protection}`)}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatDate(item.updatedAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <KeyRound />
                    </EmptyMedia>
                    <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
                    <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {!data && loading && (
        <div className="flex min-h-48 items-center justify-center gap-2 text-muted-foreground">
          <Spinner />
          {t("loading")}
        </div>
      )}
    </section>
  );
}

function Summary({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold">{children}</div>
    </div>
  );
}

function stateVariant(state: StoreStatus["state"]) {
  if (state === "READY") return "success" as const;
  if (state === "ERROR") return "destructive" as const;
  return "outline" as const;
}

function kindName(t: ReturnType<typeof useTranslations>, kind: string): string {
  const known = [
    "jira-api-token",
    "github-personal-access-token",
    "github-app-private-key",
    "cache-server-api-key",
    "cache-server-headers",
    "external-mcp-server-headers",
    "ios-profile-signer-private-key",
    "app-store-connect-private-key",
    "apns-token-private-key",
    "apns-certificate-bundle",
  ];
  return known.includes(kind) ? t(`kinds.${kind}`) : kind;
}

function featureName(
  t: ReturnType<typeof useTranslations>,
  kind: string,
  fallback: string,
): string {
  const group = kind.startsWith("jira-")
    ? "jira"
    : kind.startsWith("github-")
      ? "github"
      : kind.startsWith("cache-server-")
        ? "cache"
        : kind.startsWith("external-mcp-")
          ? "mcp"
          : kind.startsWith("ios-") || kind.startsWith("app-store-")
            ? "ios"
            : kind.startsWith("apns-")
              ? "push"
              : null;
  return group ? t(`features.${group}`) : fallback;
}
