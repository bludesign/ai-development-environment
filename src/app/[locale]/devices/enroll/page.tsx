import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/i18n/navigation";
import { resolvePublicOrigin } from "@/lib/public-origin";

export default async function EnrollDevicePage() {
  const t = await getTranslations("devices");
  const origin = resolvePublicOrigin(await headers());
  const enabled = Boolean(origin?.secure && !origin.loopback);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <Link className="text-sm text-primary hover:underline" href="/devices">
          {t("back")}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {t("enrollTitle")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("enrollDescription")}
        </p>
      </div>

      {!enabled && (
        <Alert variant="destructive">
          <AlertDescription>{t("httpsRequired")}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("collectedTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>{t("collectUdid")}</li>
            <li>{t("collectProduct")}</li>
            <li>{t("collectVersion")}</li>
            <li>{t("collectIp")}</li>
          </ul>

          <form
            action="/api/ios/enrollment/start"
            className="space-y-5"
            method="post"
          >
            <div className="space-y-2">
              <Label htmlFor="displayName">{t("deviceLabel")}</Label>
              <Input
                disabled={!enabled}
                id="displayName"
                maxLength={100}
                name="displayName"
                placeholder={t("deviceLabelPlaceholder")}
                required
              />
              <p className="text-xs text-muted-foreground">
                {t("deviceLabelHelp")}
              </p>
            </div>
            <label className="flex items-start gap-3 text-sm">
              <input
                className="mt-1 size-4"
                disabled={!enabled}
                name="consent"
                required
                type="checkbox"
                value="yes"
              />
              <span>{t("consent")}</span>
            </label>
            <Button disabled={!enabled} type="submit">
              {t("downloadProfile")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
