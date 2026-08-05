"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { authManagementRequest } from "@/lib/auth-management-client";

type UserSummary = { id: string; name: string; email: string };
type ApiKeyMetadata = {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  referenceId: string;
  enabled: boolean | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRequest: string | null;
  user: UserSummary;
};

async function apiKeyData(): Promise<{
  apiKeys: ApiKeyMetadata[];
  users: UserSummary[];
}> {
  const [keyData, userData] = await Promise.all([
    authManagementRequest<{ apiKeys: ApiKeyMetadata[] }>("api-keys"),
    authManagementRequest<{ users: UserSummary[] }>("users"),
  ]);
  return { apiKeys: keyData.apiKeys, users: userData.users };
}

export function ApiKeysPage() {
  const t = useTranslations("apiKeyManagement");
  const common = useTranslations("common");
  const [keys, setKeys] = useState<ApiKeyMetadata[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<ApiKeyMetadata | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleting, setDeleting] = useState<ApiKeyMetadata | null>(null);
  const [minimumExpiration] = useState(() =>
    new Date(Date.now() + 86_400_000).toISOString().slice(0, 16),
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiKeyData();
      setKeys(data.apiKeys);
      setUsers(data.users);
      setOwnerId((current) => current || data.users[0]?.id || "");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiKeyData()
      .then((data) => {
        if (!cancelled) {
          setKeys(data.apiKeys);
          setUsers(data.users);
          setOwnerId(data.users[0]?.id || "");
        }
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

  async function createKey(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await authManagementRequest<{
        apiKey: { key: string };
      }>("api-keys", {
        method: "POST",
        body: JSON.stringify({
          userId: ownerId,
          name,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      setCreateOpen(false);
      setName("");
      setExpiresAt("");
      setSecret(result.apiKey.key);
      setCopied(false);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  async function updateKey(keyId: string, changes: object) {
    try {
      await authManagementRequest(`api-keys/${keyId}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      setEditing(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={loading}
            onClick={() => void load()}
            variant="outline"
          >
            {loading ? <Spinner /> : <RefreshCw />}
            {t("refresh")}
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("createKey")}
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-muted-foreground">
          <KeyRound className="mt-0.5 size-5 shrink-0" />
          <p>{t("securityNotice")}</p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {keys.map((key) => (
          <Card key={key.id}>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="truncate text-base">
                  {key.name || t("unnamed")}
                </CardTitle>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {key.start ? `${key.start}…` : `${key.prefix ?? "aide_"}…`}
                </p>
              </div>
              <Badge variant={key.enabled === false ? "secondary" : "default"}>
                {key.enabled === false ? t("disabled") : t("enabled")}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("owner")}
                  </dt>
                  <dd className="truncate">{key.user.name}</dd>
                  <dd className="truncate text-xs text-muted-foreground">
                    {key.user.email}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("expires")}
                  </dt>
                  <dd>
                    {key.expiresAt
                      ? new Date(key.expiresAt).toLocaleString()
                      : t("never")}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("created")}
                  </dt>
                  <dd>{new Date(key.createdAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">
                    {t("lastUsed")}
                  </dt>
                  <dd>
                    {key.lastRequest
                      ? new Date(key.lastRequest).toLocaleString()
                      : t("never")}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                  onClick={() => {
                    setEditing(key);
                    setEditingName(key.name ?? "");
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Pencil />
                  {t("rename")}
                </Button>
                <Button
                  onClick={() =>
                    void updateKey(key.id, { enabled: key.enabled === false })
                  }
                  size="sm"
                  variant="outline"
                >
                  <ShieldOff />
                  {key.enabled === false ? t("enable") : t("disable")}
                </Button>
                <Button
                  onClick={() => setDeleting(key)}
                  size="sm"
                  variant="destructive"
                >
                  <Trash2 />
                  {t("revoke")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {!loading && keys.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <KeyRound className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-medium">{t("emptyTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("emptyDescription")}
          </p>
        </div>
      ) : null}

      <Dialog onOpenChange={setCreateOpen} open={createOpen}>
        <DialogContent>
          <form onSubmit={createKey}>
            <DialogHeader>
              <DialogTitle>{t("createTitle")}</DialogTitle>
              <DialogDescription>{t("createDescription")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="key-name">{t("name")}</Label>
                <Input
                  id="key-name"
                  onChange={(event) => setName(event.target.value)}
                  required
                  value={name}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("owner")}</Label>
                <Select onValueChange={setOwnerId} value={ownerId}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.name} · {user.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="key-expiration">
                  {t("optionalExpiration")}
                </Label>
                <Input
                  id="key-expiration"
                  min={minimumExpiration}
                  onChange={(event) => setExpiresAt(event.target.value)}
                  type="datetime-local"
                  value={expiresAt}
                />
              </div>
            </div>
            <DialogFooter>
              <Button disabled={saving || !ownerId} type="submit">
                {saving ? <Spinner /> : null}
                {t("createKey")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setSecret(null);
            setCopied(false);
          }
        }}
        open={secret !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("secretTitle")}</DialogTitle>
            <DialogDescription>{t("secretDescription")}</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted p-3 font-mono text-xs break-all select-all">
            {secret}
          </div>
          <DialogFooter>
            <Button
              onClick={async () => {
                if (!secret) return;
                await navigator.clipboard.writeText(secret);
                setCopied(true);
              }}
              type="button"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? t("copied") : t("copy")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && setEditing(null)}
        open={editing !== null}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (editing) void updateKey(editing.id, { name: editingName });
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("renameTitle")}</DialogTitle>
              <DialogDescription>{t("renameDescription")}</DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label htmlFor="rename-key">{t("name")}</Label>
              <Input
                className="mt-2"
                id="rename-key"
                onChange={(event) => setEditingName(event.target.value)}
                required
                value={editingName}
              />
            </div>
            <DialogFooter>
              <Button type="submit">{t("save")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        actionLabel={t("revoke")}
        cancelLabel={common("cancel")}
        description={
          deleting
            ? t("revokeDescription", { name: deleting.name ?? t("unnamed") })
            : ""
        }
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await authManagementRequest(`api-keys/${deleting.id}`, {
              method: "DELETE",
            });
            setDeleting(null);
            await load();
          } catch (value) {
            setError(value instanceof Error ? value.message : String(value));
          }
        }}
        onOpenChange={(open) => !open && setDeleting(null)}
        open={deleting !== null}
        title={t("revokeTitle")}
      />
    </section>
  );
}
