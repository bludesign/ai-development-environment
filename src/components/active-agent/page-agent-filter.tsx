"use client";

import { useTranslations } from "next-intl";

import {
  SearchableSelect,
  type SearchableSelectOption,
} from "@/components/common/searchable-select";
import { cn } from "@/lib/utils";

import { useActiveAgent } from "./active-agent-provider";

export const ALL_PAGE_AGENTS = "__all_agents__";

/** Place in an items-start row so the helper text never moves nearby controls. */
export function PageAgentFilter({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options?: SearchableSelectOption[];
  ariaLabel?: string;
  className?: string;
}) {
  const t = useTranslations("activeAgent");
  const { activeAgentId, activeAgent, agents, ready } = useActiveAgent();
  const available =
    options ??
    agents.map((agent) => ({
      value: agent.id,
      label: agent.name,
      keywords: agent.hostname,
    }));
  const selected = activeAgentId ?? value;
  const agentOptions = [
    { value: ALL_PAGE_AGENTS, label: t("allAgents") },
    ...available,
  ];
  if (
    selected !== ALL_PAGE_AGENTS &&
    !available.some(({ value }) => value === selected)
  ) {
    agentOptions.push({
      value: selected,
      label: activeAgent?.name ?? t("unavailable"),
    });
  }

  return (
    <div className={cn("w-full sm:w-64", className)}>
      <SearchableSelect
        ariaLabel={ariaLabel ?? t("filterLabel")}
        disabled={!ready || Boolean(activeAgentId)}
        emptyMessage={t("empty")}
        onValueChange={onValueChange}
        options={agentOptions}
        placeholder={t("allAgents")}
        searchPlaceholder={t("search")}
        value={selected}
      />
      {activeAgentId && (
        <p className="mt-1 text-xs text-muted-foreground">{t("controlled")}</p>
      )}
    </div>
  );
}
