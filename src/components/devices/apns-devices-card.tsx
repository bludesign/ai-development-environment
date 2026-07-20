"use client";

import { Check, Copy, HelpCircle, MoreHorizontal, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

export type ApnsRegistrationSummary = {
  id: string;
  clientRegistrationId: string;
  tokenMasked: string;
  topic: string;
  environment: string;
  supportedPushTypes: string[];
  displayName: string;
  deviceModel: string | null;
  osVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  locale: string | null;
  pushMagicConfigured: boolean;
  status: string;
  lastFailureReason: string | null;
  lastRegisteredAt: string;
  lastSentAt: string | null;
};

const FIELDS = `
  id clientRegistrationId tokenMasked topic environment supportedPushTypes
  displayName deviceModel osVersion appVersion appBuild locale pushMagicConfigured
  status lastFailureReason lastRegisteredAt lastSentAt
`;

export const APNS_REGISTRATION_FIELDS = FIELDS;

export function ApnsDevicesCard({
  registrations: controlledRegistrations,
  onChanged,
}: {
  registrations?: ApnsRegistrationSummary[];
  onChanged?: () => Promise<void>;
} = {}) {
  const t = useTranslations("apnsDevices");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [registrations, setRegistrations] = useState<ApnsRegistrationSummary[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rename, setRename] = useState<ApnsRegistrationSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        apnsRegistrations: ApnsRegistrationSummary[];
      }>(`query ApnsDevices { apnsRegistrations { ${FIELDS} } }`);
      setRegistrations(data.apnsRegistrations);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (controlledRegistrations !== undefined) {
      return controlPlaneSubscriptions().subscribe(
        { query: `subscription { pushNotificationsChanged }` },
        {
          next: () => void onChanged?.(),
          error: () => undefined,
          complete: () => undefined,
        },
      );
    }
    const timer = window.setTimeout(() => void load(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: `subscription { pushNotificationsChanged }` },
      {
        next: () => void load(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [controlledRegistrations, load, onChanged]);

  const mutate = async (query: string, variables: Record<string, unknown>) => {
    setBusy(true);
    try {
      await controlPlaneRequest(query, variables);
      if (onChanged) await onChanged();
      else await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const shownRegistrations = controlledRegistrations ?? registrations;
  const shownLoading = controlledRegistrations === undefined && loading;

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
        <CardAction>
          <ApnsApiHelp />
        </CardAction>
      </CardHeader>
      {error && (
        <p className="border-b p-4 text-sm text-destructive">{error}</p>
      )}
      {shownLoading ? (
        <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : shownRegistrations.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("device")}</TableHead>
              <TableHead>{t("topic")}</TableHead>
              <TableHead>{t("environment")}</TableHead>
              <TableHead>{t("pushTypes")}</TableHead>
              <TableHead>{t("token")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead>{t("lastRegistration")}</TableHead>
              <TableHead>{t("lastSend")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shownRegistrations.map((registration) => (
              <TableRow key={registration.id}>
                <TableCell>
                  <p className="font-medium">{registration.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      registration.deviceModel,
                      registration.osVersion && `iOS ${registration.osVersion}`,
                      registration.appVersion &&
                        `${registration.appVersion} (${registration.appBuild ?? "—"})`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {registration.clientRegistrationId}
                  </p>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {registration.topic}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{registration.environment}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex max-w-72 flex-wrap gap-1">
                    {registration.supportedPushTypes.map((type) => (
                      <Badge key={type} variant="secondary">
                        {type}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {registration.tokenMasked}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      registration.status === "ACTIVE"
                        ? "default"
                        : "destructive"
                    }
                  >
                    {registration.status}
                  </Badge>
                  {registration.lastFailureReason && (
                    <p className="mt-1 text-xs text-destructive">
                      {registration.lastFailureReason}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  {new Date(registration.lastRegisteredAt).toLocaleString(
                    locale,
                  )}
                </TableCell>
                <TableCell>
                  {registration.lastSentAt
                    ? new Date(registration.lastSentAt).toLocaleString(locale)
                    : "—"}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button disabled={busy} size="icon-sm" variant="ghost">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => {
                          setRename(registration);
                          setRenameValue(registration.displayName);
                        }}
                      >
                        {t("rename")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          void mutate(
                            `mutation Active($id: ID!, $active: Boolean!) { setApnsRegistrationActive(id: $id, active: $active) { id } }`,
                            {
                              id: registration.id,
                              active: registration.status !== "ACTIVE",
                            },
                          )
                        }
                      >
                        {registration.status === "ACTIVE"
                          ? t("deactivate")
                          : t("activate")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={(event) => event.preventDefault()}
                      >
                        <ConfirmationDialog
                          actionLabel={t("delete")}
                          cancelLabel={tc("cancel")}
                          description={t("deleteDescription")}
                          onConfirm={() =>
                            mutate(
                              `mutation Delete($id: ID!) { deleteApnsRegistration(id: $id) }`,
                              { id: registration.id },
                            )
                          }
                          title={t("deleteTitle")}
                          trigger={
                            <span className="flex w-full items-center gap-2">
                              <Trash2 /> {t("delete")}
                            </span>
                          }
                        />
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog
        onOpenChange={(open) => !open && setRename(null)}
        open={Boolean(rename)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rename")}</DialogTitle>
            <DialogDescription>{t("renameDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="apns-rename">{t("displayName")}</Label>
            <Input
              id="apns-rename"
              onChange={(event) => setRenameValue(event.target.value)}
              value={renameValue}
            />
          </div>
          <DialogFooter>
            <Button onClick={() => setRename(null)} variant="outline">
              {tc("cancel")}
            </Button>
            <Button
              disabled={busy || !renameValue.trim()}
              onClick={() => {
                if (!rename) return;
                void mutate(
                  `mutation Rename($id: ID!, $name: String!) { renameApnsRegistration(id: $id, displayName: $name) { id } }`,
                  { id: rename.id, name: renameValue },
                ).then(() => setRename(null));
              }}
            >
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

const EXAMPLE = {
  clientRegistrationId: "install-2FC735A5-734D-4A41-A1DD-BC8444796894",
  token: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
  tokenEncoding: "HEX",
  topic: "com.example.MyApp",
  environment: "SANDBOX",
  supportedPushTypes: ["alert", "background"],
  displayName: "Chandler’s iPhone",
  deviceModel: "iPhone18,1",
  osVersion: "26.0",
  appVersion: "4.2",
  appBuild: "310",
  locale: "en_US",
};

function ApnsApiHelp() {
  const t = useTranslations("apnsDevices");
  const [copied, setCopied] = useState<string | null>(null);
  const markdown = `POST /api/ios/apns-devices\nContent-Type: application/json\n\n\`\`\`json\n${JSON.stringify(EXAMPLE, null, 2)}\n\`\`\``;
  const curl = `curl -X POST "$BASE_URL/api/ios/apns-devices" \\\n+  -H 'Content-Type: application/json' \\\n+  --data '${JSON.stringify(EXAMPLE)}'`;
  const swift = `let body: [String: Any] = ${JSON.stringify(EXAMPLE, null, 2)}\nvar request = URLRequest(url: baseURL.appending(path: "/api/ios/apns-devices"))\nrequest.httpMethod = "POST"\nrequest.setValue("application/json", forHTTPHeaderField: "Content-Type")\nrequest.httpBody = try JSONSerialization.data(withJSONObject: body)\nlet (_, response) = try await URLSession.shared.data(for: request)`;
  const copy = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    window.setTimeout(() => setCopied(null), 1500);
  };
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <HelpCircle /> {t("apiHelp")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("apiHelpTitle")}</DialogTitle>
          <DialogDescription>{t("apiHelpDescription")}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="markdown">
          <TabsList>
            <TabsTrigger value="markdown">Markdown</TabsTrigger>
            <TabsTrigger value="curl">cURL</TabsTrigger>
            <TabsTrigger value="swift">Swift</TabsTrigger>
          </TabsList>
          {[
            ["markdown", markdown],
            ["curl", curl],
            ["swift", swift],
          ].map(([name, value]) => (
            <TabsContent key={name} value={name}>
              <div className="relative">
                <pre className="max-h-[55vh] overflow-auto rounded-xl bg-muted p-4 text-xs whitespace-pre-wrap">
                  {value}
                </pre>
                <Button
                  className="absolute right-2 top-2"
                  onClick={() => void copy(name!, value!)}
                  size="icon-sm"
                  variant="secondary"
                >
                  {copied === name ? <Check /> : <Copy />}
                </Button>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
