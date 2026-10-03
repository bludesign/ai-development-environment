"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { BuildRecord } from "./types";

export function buildConfigurationName(
  build: Pick<BuildRecord, "snapshot" | "configuration">,
  customLabel: string,
) {
  const captured = build.snapshot.configuration as
    { kind?: string; name?: string } | undefined;
  return captured?.kind === "CUSTOM"
    ? customLabel
    : (captured?.name ?? build.configuration?.name ?? "—");
}

export function BuildConfigurationLabel({
  build,
}: {
  build: Pick<BuildRecord, "snapshot" | "configuration">;
}) {
  const t = useTranslations("builds");
  const name = buildConfigurationName(build, t("custom"));
  const captured = build.snapshot.configuration as
    { kind?: string } | undefined;
  if (captured?.kind === "CUSTOM") return <span>{name}</span>;
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
