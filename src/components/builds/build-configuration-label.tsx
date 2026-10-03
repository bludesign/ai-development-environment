"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { BuildRecord } from "./types";

export function BuildConfigurationLabel({
  build,
}: {
  build: Pick<BuildRecord, "snapshot" | "configuration">;
}) {
  const t = useTranslations("builds");
  const captured = build.snapshot.configuration as
    { kind?: string; name?: string } | undefined;
  if (captured?.kind === "CUSTOM") return <span>{t("custom")}</span>;
  const name = captured?.name ?? build.configuration?.name ?? "—";
  return build.configuration ? (
    <Link
      href={`/dashboard/builds/configurations/${build.configuration.id}`}
      className="hover:underline"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {name}
    </Link>
  ) : (
    <span>{name}</span>
  );
}
