"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Laptop,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { authManagementRequest } from "@/lib/auth-management-client";

type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
};

type User = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: string;
  updatedAt: string;
  providers: string[];
  sessions: Session[];
};

type UsersResponse = { currentUserId: string; users: User[] };
type AuthConfig = {
  mode: "password" | "oidc" | "both";
  registration: { enabled: boolean; setupRequired: boolean };
};

type UserDraft = {
  name: string;
  email: string;
  password: string;
};

const emptyDraft = (): UserDraft => ({ name: "", email: "", password: "" });

async function usersData(search = ""): Promise<{
  users: UsersResponse;
  config: AuthConfig;
}> {
  const [users, config] = await Promise.all([
    authManagementRequest<UsersResponse>(
      `users${search ? `?search=${encodeURIComponent(search)}` : ""}`,
    ),
    fetch("/api/auth/config").then(
      (response) => response.json() as Promise<AuthConfig>,
    ),
  ]);
  return { users, config };
}

export function UsersPage() {
  const t = useTranslations("userManagement");
  const common = useTranslations("common");
  const [data, setData] = useState<UsersResponse | null>(null);
  const [configuration, setConfiguration] = useState<AuthConfig | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<User | "new" | null>(null);
  const [draft, setDraft] = useState<UserDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<User | null>(null);

  const load = useCallback(async (search = "") => {
    setLoading(true);
    setError(null);
    try {
      const { users, config } = await usersData(search);
      setData(users);
      setConfiguration(config);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void usersData()
      .then(({ users, config }) => {
        if (!cancelled) {
          setData(users);
          setConfiguration(config);
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

  function openEditor(user: User | "new") {
    setEditor(user);
    setDraft(
      user === "new"
        ? emptyDraft()
        : { name: user.name, email: user.email, password: "" },
    );
  }

  async function saveUser(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      if (editor === "new") {
        await authManagementRequest("users", {
          method: "POST",
          body: JSON.stringify(draft),
        });
      } else {
        await authManagementRequest(`users/${editor.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: draft.name,
            email: draft.email,
            ...(draft.password ? { password: draft.password } : {}),
          }),
        });
      }
      setEditor(null);
      await load(query);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  async function setRegistration(enabled: boolean) {
    try {
      const registration = await authManagementRequest<
        AuthConfig["registration"]
      >("registration", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      setConfiguration((current) =>
        current ? { ...current, registration } : current,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function revokeSession(sessionId: string) {
    try {
      await authManagementRequest(`sessions/${sessionId}`, {
        method: "DELETE",
      });
      await load(query);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  const passwordEnabled = configuration?.mode !== "oidc";

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
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={loading}
            onClick={() => void load(query)}
            variant="outline"
          >
            {loading ? <Spinner /> : <RefreshCw />}
            {t("refresh")}
          </Button>
          {passwordEnabled ? (
            <Button onClick={() => openEditor("new")}>
              <Plus />
              {t("createUser")}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{t("registrationTitle")}</p>
              <p className="text-xs text-muted-foreground">
                {configuration?.registration.enabled
                  ? t("registrationEnabled")
                  : t("registrationDisabled")}
              </p>
            </div>
          </div>
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={configuration?.registration.enabled ?? false}
              onCheckedChange={(checked) =>
                void setRegistration(checked === true)
              }
            />
            {t("allowRegistration")}
          </Label>
        </CardContent>
      </Card>

      <div className="relative max-w-md">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t("search")}
          className="pl-9"
          onChange={(event) => {
            setQuery(event.target.value);
            void load(event.target.value);
          }}
          placeholder={t("searchPlaceholder")}
          value={query}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {data?.users.map((user) => {
          const isCurrent = user.id === data.currentUserId;
          return (
            <Card key={user.id}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <UserRound className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">
                      {user.name}
                    </CardTitle>
                    <p className="truncate text-sm text-muted-foreground">
                      {user.email}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  {isCurrent ? <Badge>{t("currentUser")}</Badge> : null}
                  <Button
                    aria-label={t("editNamed", { name: user.name })}
                    onClick={() => openEditor(user)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                  <Button
                    aria-label={t("deleteNamed", { name: user.name })}
                    disabled={isCurrent || (data?.users.length ?? 0) <= 1}
                    onClick={() => setDeleting(user)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {user.providers.map((provider) => (
                    <Badge key={provider} variant="outline">
                      {provider === "credential"
                        ? t("passwordProvider")
                        : provider}
                    </Badge>
                  ))}
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("sessions", { count: user.sessions.length })}
                  </p>
                  {user.sessions.length ? (
                    user.sessions.map((session) => (
                      <div
                        className="flex items-center gap-3 rounded-lg border p-3"
                        key={session.id}
                      >
                        <Laptop className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs">
                            {session.userAgent || t("unknownDevice")}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {new Date(session.updatedAt).toLocaleString()}
                          </p>
                        </div>
                        <Button
                          aria-label={t("revokeSession")}
                          onClick={() => void revokeSession(session.id)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <X />
                        </Button>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("noSessions")}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        onOpenChange={(open) => !open && setEditor(null)}
        open={editor !== null}
      >
        <DialogContent>
          <form onSubmit={saveUser}>
            <DialogHeader>
              <DialogTitle>
                {editor === "new" ? t("createTitle") : t("editTitle")}
              </DialogTitle>
              <DialogDescription>
                {editor === "new"
                  ? t("createDescription")
                  : t("editDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="user-name">{t("name")}</Label>
                <Input
                  id="user-name"
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                  required
                  value={draft.name}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-email">{t("email")}</Label>
                <Input
                  id="user-email"
                  onChange={(event) =>
                    setDraft({ ...draft, email: event.target.value })
                  }
                  required
                  type="email"
                  value={draft.email}
                />
              </div>
              {passwordEnabled ? (
                <div className="space-y-2">
                  <Label htmlFor="user-password">{t("password")}</Label>
                  <Input
                    id="user-password"
                    minLength={8}
                    onChange={(event) =>
                      setDraft({ ...draft, password: event.target.value })
                    }
                    placeholder={
                      editor === "new" ? undefined : t("leavePasswordBlank")
                    }
                    required={editor === "new"}
                    type="password"
                    value={draft.password}
                  />
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button disabled={saving} type="submit">
                {saving ? <Spinner /> : null}
                {editor === "new" ? t("createUser") : t("saveChanges")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        actionLabel={t("delete")}
        cancelLabel={common("cancel")}
        description={
          deleting ? t("deleteDescription", { name: deleting.name }) : ""
        }
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await authManagementRequest(`users/${deleting.id}`, {
              method: "DELETE",
            });
            setDeleting(null);
            await load(query);
          } catch (value) {
            setError(value instanceof Error ? value.message : String(value));
          }
        }}
        onOpenChange={(open) => !open && setDeleting(null)}
        open={deleting !== null}
        title={t("deleteTitle")}
      />
    </section>
  );
}
