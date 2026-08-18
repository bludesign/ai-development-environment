"use client";

import { useState, type FormEvent } from "react";
import { Blocks } from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/i18n/navigation";
import { authClient } from "@/services/auth/auth-client";
import type { AuthMode } from "@/services/auth/auth-config";

type PublicAuthConfig = {
  mode: AuthMode;
  registration: { enabled: boolean; setupRequired: boolean };
  provider: { id: string; name: string } | null;
};

export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/")) return "/";
  try {
    const base = new URL("https://aide.invalid");
    const destination = new URL(value, base);
    if (destination.origin !== base.origin) return "/";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}

export function AuthForm({
  configuration,
  intent,
  returnTo,
}: {
  configuration: PublicAuthConfig;
  intent: "sign-in" | "register";
  returnTo?: string;
}) {
  const t = useTranslations("auth");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordEnabled =
    configuration.mode === "password" || configuration.mode === "both";
  const oauthEnabled =
    configuration.mode === "oidc" || configuration.mode === "both";
  const canRegister = configuration.registration.enabled;
  const destination = safeReturnTo(returnTo);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result =
      intent === "register"
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });
    if (result.error) {
      setError(result.error.message ?? t("unknownError"));
      setSubmitting(false);
      return;
    }
    window.location.assign(destination);
  }

  async function startOAuth() {
    if (!configuration.provider) return;
    setSubmitting(true);
    setError(null);
    const result = await authClient.signIn.social({
      provider: configuration.provider.id,
      callbackURL: destination,
      requestSignUp: intent === "register",
    });
    if (result.error) {
      setError(result.error.message ?? t("unknownError"));
      setSubmitting(false);
    }
  }

  const registrationUnavailable = intent === "register" && !canRegister;

  return (
    <main className="flex min-h-dvh items-center justify-center overflow-auto bg-muted/30 p-4 sm:p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Blocks className="size-5" />
          </div>
          <span className="font-semibold">{t("productName")}</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              {intent === "sign-in"
                ? t("signInTitle")
                : configuration.registration.setupRequired
                  ? t("setupTitle")
                  : t("registerTitle")}
            </CardTitle>
            <CardDescription>
              {registrationUnavailable
                ? t("registrationDisabled")
                : intent === "sign-in"
                  ? t("signInDescription")
                  : configuration.registration.setupRequired
                    ? t("setupDescription")
                    : t("registerDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {!registrationUnavailable && passwordEnabled ? (
              <form className="space-y-4" onSubmit={submitPassword}>
                {intent === "register" ? (
                  <div className="space-y-2">
                    <Label htmlFor="name">{t("name")}</Label>
                    <Input
                      autoComplete="name"
                      id="name"
                      onChange={(event) => setName(event.target.value)}
                      required
                      value={name}
                    />
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label htmlFor="email">{t("email")}</Label>
                  <Input
                    autoComplete="email"
                    id="email"
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    type="email"
                    value={email}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">{t("password")}</Label>
                  <Input
                    autoComplete={
                      intent === "register"
                        ? "new-password"
                        : "current-password"
                    }
                    id="password"
                    minLength={8}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                </div>
                <Button className="w-full" disabled={submitting} type="submit">
                  {intent === "sign-in" ? t("signIn") : t("createAccount")}
                </Button>
              </form>
            ) : null}

            {!registrationUnavailable &&
            oauthEnabled &&
            configuration.provider ? (
              <>
                {passwordEnabled ? (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <div className="h-px flex-1 bg-border" />
                    {t("or")}
                    <div className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                <Button
                  className="w-full"
                  disabled={submitting}
                  onClick={startOAuth}
                  type="button"
                  variant="outline"
                >
                  {t("continueWith", { provider: configuration.provider.name })}
                </Button>
              </>
            ) : null}

            <p className="text-center text-sm text-muted-foreground">
              {intent === "sign-in" ? (
                canRegister ? (
                  <>
                    {t("needAccount")}{" "}
                    <Link
                      className="font-medium text-foreground underline"
                      href="/register"
                    >
                      {configuration.registration.setupRequired
                        ? t("completeSetup")
                        : t("register")}
                    </Link>
                  </>
                ) : null
              ) : (
                <>
                  {t("haveAccount")}{" "}
                  <Link
                    className="font-medium text-foreground underline"
                    href="/sign-in"
                  >
                    {t("signIn")}
                  </Link>
                </>
              )}
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
