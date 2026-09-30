import { DeviceEnrollmentForm } from "@/components/devices/device-enrollment-form";
import { getTranslations } from "next-intl/server";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function EnrollDevicePage() {
  const t = await getTranslations("devices");

  return (
    <section className="flex w-full flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("enrollTitle")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("enrollDescription")}
        </p>
      </div>

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

          <DeviceEnrollmentForm />
        </CardContent>
      </Card>
    </section>
  );
}
