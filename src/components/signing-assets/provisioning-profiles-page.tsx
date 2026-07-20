"use client";

import {
  Download,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { Link } from "@/i18n/navigation";

type Agent = { id: string; name: string; hostname: string; supported: boolean };
type Profile = {
  id: string;
  uuid: string;
  name: string;
  profileType: string;
  bundleId: string;
  teamId: string | null;
  teamName: string | null;
  platforms: string[];
  deviceCount: number;
  certificateSha1s: string[];
  expiresAt: string | null;
  expired: boolean;
  xcodeManaged: boolean;
  installedAgents: Array<{ id: string; name: string }>;
};
type Certificate = {
  id: string;
  sha1: string;
  sha256: string | null;
  name: string;
  teamId: string | null;
  certificateType: string | null;
  expiresAt: string | null;
  expired: boolean;
  hasPrivateKey: boolean;
  installedAgents: Array<{ id: string; name: string }>;
};
type AppleResource = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
};
type Operation = {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    status: string;
    error: string | null;
    agent: { id: string; name: string };
  }>;
};

const LOCAL_QUERY = `query SigningAssetsPage {
  signingAgents { id name hostname supported lastSeenAt }
  signingProfiles {
    id uuid name profileType bundleId teamId teamName platforms deviceCount
    certificateSha1s expiresAt expired xcodeManaged installedAgents { id name }
  }
  signingCertificates {
    id sha1 sha256 name teamId certificateType expiresAt expired hasPrivateKey
    installedAgents { id name }
  }
  signingOperations(limit: 20) {
    id kind status error createdAt
    items { id status error agent { id name } }
  }
}`;

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read file"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function shortFingerprint(value: string | null) {
  return value ? `${value.slice(0, 12)}…${value.slice(-12)}` : "—";
}

function downloadBase64(contentBase64: string, filename: string) {
  const binary = atob(contentBase64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ProvisioningProfilesPage() {
  const t = useTranslations("provisioningProfiles");
  const tc = useTranslations("common");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [certificates, setCertificates] = useState<Certificate[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [portal, setPortal] = useState<{
    profiles: AppleResource[];
    certificates: AppleResource[];
    bundleIds: AppleResource[];
    devices: AppleResource[];
  } | null>(null);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [passphrase, setPassphrase] = useState("");
  const [portalProfileName, setPortalProfileName] = useState("");
  const [portalProfileType, setPortalProfileType] = useState(
    "IOS_APP_DEVELOPMENT",
  );
  const [portalBundleId, setPortalBundleId] = useState("");
  const [portalCertificateId, setPortalCertificateId] = useState("");
  const [assetTab, setAssetTab] = useState("profiles");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        signingAgents: Agent[];
        signingProfiles: Profile[];
        signingCertificates: Certificate[];
        signingOperations: Operation[];
      }>(LOCAL_QUERY);
      setAgents(data.signingAgents);
      setProfiles(data.signingProfiles);
      setCertificates(data.signingCertificates);
      setOperations(data.signingOperations);
      setTargets((current) =>
        current.size
          ? current
          : new Set(
              data.signingAgents
                .filter((agent) => agent.supported)
                .map((agent) => agent.id),
            ),
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPortal = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        appleDeveloperInventory: {
          profiles: AppleResource[];
          certificates: AppleResource[];
          bundleIds: AppleResource[];
          devices: AppleResource[];
        };
      }>(`query AppleDeveloperSigningInventory {
        appleDeveloperInventory {
          profiles { id type attributes }
          certificates { id type attributes }
          bundleIds { id type attributes }
          devices { id type attributes }
        }
      }`);
      setPortal(data.appleDeveloperInventory);
      setPortalError(null);
    } catch (value) {
      setPortalError(value instanceof Error ? value.message : String(value));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      void loadPortal();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadPortal]);

  const mutate = async (query: string, variables?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await controlPlaneRequest(query, variables);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const uploadProfile = async (file: File | null) => {
    if (!file) return;
    await mutate(
      `mutation UploadProfile($content: String!, $agents: [ID!]!) {
        uploadSigningProfile(contentBase64: $content, targetAgentIds: $agents) { id }
      }`,
      { content: await fileBase64(file), agents: [...targets] },
    );
  };

  const uploadIdentity = async (file: File | null) => {
    if (!file) return;
    await mutate(
      `mutation ImportIdentity($content: String!, $passphrase: String!, $agents: [ID!]!) {
        importSigningIdentity(p12Base64: $content, passphrase: $passphrase, targetAgentIds: $agents) { id }
      }`,
      {
        content: await fileBase64(file),
        passphrase,
        agents: [...targets],
      },
    );
    setPassphrase("");
  };

  const downloadProfile = async (profile: Profile) => {
    const agent = profile.installedAgents[0];
    if (!agent) return;
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        downloadSigningProfile: {
          filename: string;
          contentBase64: string;
        };
      }>(
        `mutation DownloadProfile($uuid: String!, $agentId: ID!) {
          downloadSigningProfile(uuid: $uuid, agentId: $agentId) { filename contentBase64 }
        }`,
        { uuid: profile.uuid, agentId: agent.id },
      );
      downloadBase64(
        data.downloadSigningProfile.contentBase64,
        data.downloadSigningProfile.filename,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          disabled={busy || loading}
          onClick={() =>
            void mutate(`mutation { refreshSigningAssets { id } }`)
          }
          variant="outline"
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />{" "}
          {t("refresh")}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("agents")}</CardTitle>
          <CardDescription>{t("agentsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {agents.map((agent) => (
            <label
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
              key={agent.id}
            >
              <Checkbox
                checked={targets.has(agent.id)}
                disabled={!agent.supported}
                onCheckedChange={(checked) =>
                  setTargets((current) => {
                    const next = new Set(current);
                    if (checked) next.add(agent.id);
                    else next.delete(agent.id);
                    return next;
                  })
                }
              />
              <span>{agent.name}</span>
              {!agent.supported && (
                <Badge variant="secondary">{t("unsupported")}</Badge>
              )}
            </label>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("uploadProfile")}</CardTitle>
            <CardDescription>{t("uploadProfileDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-8">
              <Upload /> {t("chooseMobileprovision")}
              <Input
                accept=".mobileprovision,.provisionprofile"
                className="sr-only"
                disabled={busy || !targets.size}
                onChange={(event) =>
                  void uploadProfile(event.target.files?.[0] ?? null)
                }
                type="file"
              />
            </Label>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("importIdentity")}</CardTitle>
            <CardDescription>{t("importIdentityDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={t("passphrase")}
              type="password"
              value={passphrase}
            />
            <Label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed p-5">
              <KeyRound /> {t("chooseP12")}
              <Input
                accept=".p12,.pfx"
                className="sr-only"
                disabled={busy || !targets.size}
                onChange={(event) =>
                  void uploadIdentity(event.target.files?.[0] ?? null)
                }
                type="file"
              />
            </Label>
          </CardContent>
        </Card>
      </div>

      <Tabs onValueChange={setAssetTab} value={assetTab}>
        <Select onValueChange={setAssetTab} value={assetTab}>
          <SelectTrigger className="w-full sm:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="profiles">{t("localProfiles")}</SelectItem>
            <SelectItem value="certificates">
              {t("localCertificates")}
            </SelectItem>
            <SelectItem value="portal">{t("applePortal")}</SelectItem>
          </SelectContent>
        </Select>
        <TabsList className="hidden sm:inline-flex">
          <TabsTrigger value="profiles">
            <ShieldCheck /> {t("localProfiles")}
          </TabsTrigger>
          <TabsTrigger value="certificates">
            <KeyRound /> {t("localCertificates")}
          </TabsTrigger>
          <TabsTrigger value="portal">{t("applePortal")}</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles">
          <Card className="gap-0 py-0">
            <CardHeader className="border-b py-4 max-sm:has-data-[slot=card-action]:grid-cols-1">
              <CardTitle>{t("localProfiles")}</CardTitle>
              <CardDescription>{t("profilesDescription")}</CardDescription>
              <CardAction className="max-sm:col-start-1 max-sm:row-start-3 max-sm:row-span-1 max-sm:mt-3 max-sm:justify-self-stretch">
                <ConfirmationDialog
                  actionLabel={t("deleteExpired")}
                  cancelLabel={tc("cancel")}
                  description={t("deleteExpiredDescription")}
                  onConfirm={() =>
                    mutate(`mutation { deleteExpiredSigningProfiles { id } }`)
                  }
                  title={t("deleteExpired")}
                  trigger={
                    <Button disabled={busy} size="sm" variant="outline">
                      <Trash2 /> {t("deleteExpired")}
                    </Button>
                  }
                />
              </CardAction>
            </CardHeader>
            {profiles.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {t("noLocalProfiles")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("name")}</TableHead>
                    <TableHead>{t("bundleId")}</TableHead>
                    <TableHead>{t("type")}</TableHead>
                    <TableHead>{t("team")}</TableHead>
                    <TableHead>{t("devices")}</TableHead>
                    <TableHead>{t("expires")}</TableHead>
                    <TableHead>{t("installedAgents")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profiles.map((profile) => {
                    const installed = new Set(
                      profile.installedAgents.map((agent) => agent.id),
                    );
                    const missing = agents.filter(
                      (agent) => agent.supported && !installed.has(agent.id),
                    );
                    return (
                      <TableRow key={profile.id}>
                        <TableCell>
                          <Link
                            className="font-medium hover:underline"
                            href={`/provisioning-profiles/${encodeURIComponent(profile.id)}`}
                          >
                            {profile.name}
                          </Link>
                          <p className="font-mono text-xs text-muted-foreground">
                            {profile.uuid}
                          </p>
                          {profile.xcodeManaged && (
                            <Badge variant="secondary">Xcode</Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {profile.bundleId}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{profile.profileType}</Badge>
                        </TableCell>
                        <TableCell>
                          {profile.teamName ?? profile.teamId ?? "—"}
                        </TableCell>
                        <TableCell>{profile.deviceCount}</TableCell>
                        <TableCell>
                          {profile.expiresAt
                            ? new Date(profile.expiresAt).toLocaleDateString()
                            : "—"}
                          {profile.expired && (
                            <Badge className="ml-2" variant="destructive">
                              {t("expired")}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {profile.installedAgents
                            .map((agent) => agent.name)
                            .join(", ")}
                        </TableCell>
                        <TableCell className="space-x-1 text-right">
                          {missing.length > 0 && profile.installedAgents[0] && (
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void mutate(
                                  `mutation Sync($uuid: String!, $source: ID!, $targets: [ID!]!) { syncSigningProfile(uuid: $uuid, sourceAgentId: $source, targetAgentIds: $targets) { id } }`,
                                  {
                                    uuid: profile.uuid,
                                    source: profile.installedAgents[0]!.id,
                                    targets: missing.map((agent) => agent.id),
                                  },
                                )
                              }
                              size="sm"
                              variant="outline"
                            >
                              {t("syncMissing")}
                            </Button>
                          )}
                          <Button
                            aria-label={t("download")}
                            disabled={busy || !profile.installedAgents.length}
                            onClick={() => void downloadProfile(profile)}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <Download />
                          </Button>
                          <ConfirmationDialog
                            actionLabel={t("delete")}
                            cancelLabel={tc("cancel")}
                            description={t("deleteProfileDescription")}
                            onConfirm={() =>
                              mutate(
                                `mutation Delete($uuid: String!, $agents: [ID!]!) { deleteSigningProfile(uuid: $uuid, agentIds: $agents) { id } }`,
                                {
                                  uuid: profile.uuid,
                                  agents: profile.installedAgents.map(
                                    (agent) => agent.id,
                                  ),
                                },
                              )
                            }
                            title={t("deleteProfile")}
                            trigger={
                              <Button
                                disabled={busy}
                                size="icon-sm"
                                variant="ghost"
                              >
                                <Trash2 />
                              </Button>
                            }
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="certificates">
          <Card className="gap-0 py-0">
            <CardHeader className="border-b py-4">
              <CardTitle>{t("localCertificates")}</CardTitle>
              <CardDescription>{t("certificatesDescription")}</CardDescription>
            </CardHeader>
            {certificates.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {t("noLocalCertificates")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("name")}</TableHead>
                    <TableHead>{t("fingerprints")}</TableHead>
                    <TableHead>{t("team")}</TableHead>
                    <TableHead>{t("privateKey")}</TableHead>
                    <TableHead>{t("expires")}</TableHead>
                    <TableHead>{t("installedAgents")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {certificates.map((certificate) => (
                    <TableRow key={certificate.id}>
                      <TableCell>
                        <p className="font-medium">{certificate.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {certificate.certificateType}
                        </p>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <p>SHA-1 {shortFingerprint(certificate.sha1)}</p>
                        <p>SHA-256 {shortFingerprint(certificate.sha256)}</p>
                      </TableCell>
                      <TableCell>{certificate.teamId ?? "—"}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            certificate.hasPrivateKey
                              ? "default"
                              : "destructive"
                          }
                        >
                          {certificate.hasPrivateKey
                            ? t("available")
                            : t("missing")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {certificate.expiresAt
                          ? new Date(certificate.expiresAt).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {certificate.installedAgents
                          .map((agent) => agent.name)
                          .join(", ")}
                      </TableCell>
                      <TableCell>
                        <ConfirmationDialog
                          actionLabel={t("delete")}
                          cancelLabel={tc("cancel")}
                          description={t("deleteIdentityDescription")}
                          onConfirm={() =>
                            mutate(
                              `mutation DeleteIdentity($sha1: String!, $agents: [ID!]!) { deleteSigningIdentity(sha1: $sha1, agentIds: $agents) { id } }`,
                              {
                                sha1: certificate.sha1,
                                agents: certificate.installedAgents.map(
                                  (agent) => agent.id,
                                ),
                              },
                            )
                          }
                          title={t("deleteIdentity")}
                          trigger={
                            <Button
                              disabled={busy || !certificate.hasPrivateKey}
                              size="icon-sm"
                              variant="ghost"
                            >
                              <Trash2 />
                            </Button>
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </TabsContent>
        <TabsContent className="space-y-4 pb-4" value="portal">
          {portalError && (
            <Alert className="px-4 py-3" variant="destructive">
              <AlertDescription>{portalError}</AlertDescription>
            </Alert>
          )}
          {!portal && !portalError ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner /> {t("loadingPortal")}
            </p>
          ) : portal ? (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t("createPortalProfile")}</CardTitle>
                  <CardDescription>
                    {t("createPortalProfileDescription")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  <Input
                    onChange={(event) =>
                      setPortalProfileName(event.target.value)
                    }
                    placeholder={t("profileName")}
                    value={portalProfileName}
                  />
                  <Select
                    onValueChange={setPortalProfileType}
                    value={portalProfileType}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[
                        "IOS_APP_DEVELOPMENT",
                        "IOS_APP_ADHOC",
                        "IOS_APP_STORE",
                        "IOS_APP_INHOUSE",
                      ].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    onValueChange={setPortalBundleId}
                    value={portalBundleId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("selectBundleId")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(portal?.bundleIds ?? []).map((resource) => (
                        <SelectItem key={resource.id} value={resource.id}>
                          {String(
                            resource.attributes.identifier ?? resource.id,
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    onValueChange={setPortalCertificateId}
                    value={portalCertificateId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("selectCertificate")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(portal?.certificates ?? []).map((resource) => (
                        <SelectItem key={resource.id} value={resource.id}>
                          {String(
                            resource.attributes.displayName ??
                              resource.attributes.name ??
                              resource.id,
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={
                      busy ||
                      !portalProfileName ||
                      !portalBundleId ||
                      !portalCertificateId
                    }
                    onClick={() =>
                      void mutate(
                        `mutation CreatePortal($input: CreateApplePortalProfileInput!) { createApplePortalProfile(input: $input) { id } }`,
                        {
                          input: {
                            name: portalProfileName,
                            profileType: portalProfileType,
                            bundleIdId: portalBundleId,
                            certificateIds: [portalCertificateId],
                            deviceIds: [
                              "IOS_APP_DEVELOPMENT",
                              "IOS_APP_ADHOC",
                            ].includes(portalProfileType)
                              ? (portal?.devices ?? []).map(
                                  (resource) => resource.id,
                                )
                              : [],
                          },
                        },
                      ).then(async () => {
                        setPortalProfileName("");
                        await loadPortal();
                      })
                    }
                  >
                    {t("create")}
                  </Button>
                </CardContent>
              </Card>
              <div className="grid gap-4 lg:grid-cols-2">
                <PortalCard
                  resources={portal?.profiles ?? []}
                  title={t("portalProfiles")}
                  onDelete={(id) =>
                    mutate(
                      `mutation DeletePortal($id: ID!) { deleteApplePortalProfile(id: $id) }`,
                      { id },
                    ).then(loadPortal)
                  }
                />
                <PortalCard
                  resources={portal?.certificates ?? []}
                  title={t("portalCertificates")}
                  onDelete={(id) =>
                    mutate(
                      `mutation RevokePortal($id: ID!) { revokeApplePortalCertificate(id: $id) }`,
                      { id },
                    ).then(loadPortal)
                  }
                />
              </div>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>

      {operations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("operations")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {operations.map((operation) => (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                key={operation.id}
              >
                <span>{operation.kind}</span>
                <span>
                  {operation.items
                    .map((item) => `${item.agent.name}: ${item.status}`)
                    .join(" · ")}
                </span>
                <Badge
                  variant={
                    operation.status === "FAILED" ? "destructive" : "secondary"
                  }
                >
                  {operation.status}
                </Badge>
                {operation.error && (
                  <p className="w-full text-xs text-destructive">
                    {operation.error}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function PortalCard({
  resources,
  title,
  onDelete,
}: {
  resources: AppleResource[];
  title: string;
  onDelete: (id: string) => Promise<void>;
}) {
  const t = useTranslations("provisioningProfiles");
  const tc = useTranslations("common");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {resources.length ? (
          resources.map((resource) => (
            <div
              className="flex items-start justify-between gap-3 rounded-lg border p-3"
              key={resource.id}
            >
              <div>
                <p className="font-medium">
                  {String(
                    resource.attributes.name ??
                      resource.attributes.displayName ??
                      resource.id,
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {String(
                    resource.attributes.profileType ??
                      resource.attributes.certificateType ??
                      "",
                  )}
                </p>
                <p className="font-mono text-xs">{resource.id}</p>
              </div>
              <div className="flex gap-1">
                {typeof resource.attributes.profileContent === "string" && (
                  <Button
                    aria-label={t("download")}
                    onClick={() =>
                      downloadBase64(
                        resource.attributes.profileContent as string,
                        `${String(resource.attributes.uuid ?? resource.id)}.mobileprovision`,
                      )
                    }
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Download />
                  </Button>
                )}
                <ConfirmationDialog
                  actionLabel={t("delete")}
                  cancelLabel={tc("cancel")}
                  description={t("portalDeleteDescription")}
                  onConfirm={() => onDelete(resource.id)}
                  title={t("confirmPortalDelete")}
                  trigger={
                    <Button size="icon-sm" variant="ghost">
                      <Trash2 />
                    </Button>
                  }
                />
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        )}
      </CardContent>
    </Card>
  );
}
