import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";

import type { Simulator } from "./simulator-client";

export function SimulatorStateBadge({ simulator }: { simulator: Simulator }) {
  const t = useTranslations("simulators");
  const state = simulator.state.toLowerCase();
  const label = !simulator.isAvailable
    ? t("unavailable")
    : state === "booted"
      ? t("booted")
      : state === "shutdown"
        ? t("shutDown")
        : simulator.state;
  return (
    <Badge
      variant={
        simulator.isAvailable && state === "booted" ? "default" : "outline"
      }
    >
      {label}
    </Badge>
  );
}
