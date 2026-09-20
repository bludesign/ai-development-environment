"use client";

import { Check, ChevronsUpDown, Server } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useActiveAgent } from "./active-agent-provider";

export function ActiveAgentSelector() {
  const t = useTranslations("activeAgent");
  const {
    activeAgentId,
    activeAgent,
    agents,
    ready,
    loading,
    error,
    selectAgent,
    refresh,
  } = useActiveAgent();
  const [open, setOpen] = useState(false);
  const name =
    activeAgent?.name ?? (activeAgentId ? t("unavailable") : t("none"));
  const select = (id: string | null) => {
    selectAgent(id);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) refresh();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={t("label", { name })}
          aria-expanded={open}
          role="combobox"
          disabled={!ready}
          className="relative h-10 w-10 shrink-0 justify-center gap-2 px-0 @xl:w-44 @xl:justify-start @xl:px-3"
          variant="outline"
          title={t("label", { name })}
        >
          <Server className="size-4 shrink-0" />
          {activeAgentId && (
            <span
              aria-hidden="true"
              className="absolute top-1 right-1 size-2 rounded-full bg-primary @xl:hidden"
            />
          )}
          <span className="hidden min-w-0 flex-1 truncate text-left @xl:inline">
            {name}
          </span>
          <ChevronsUpDown className="hidden size-4 shrink-0 @xl:block" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        <Command>
          <CommandInput placeholder={t("search")} />
          <CommandList>
            <CommandEmpty>{t("empty")}</CommandEmpty>
            <CommandGroup heading={t("title")}>
              <CommandItem value={t("none")} onSelect={() => select(null)}>
                <Check className={activeAgentId ? "invisible" : undefined} />
                {t("none")}
              </CommandItem>
              {agents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={agent.id}
                  keywords={[agent.name, agent.hostname]}
                  onSelect={() => select(agent.id)}
                >
                  <Check
                    className={
                      activeAgentId === agent.id ? undefined : "invisible"
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{agent.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {agent.hostname} ·{" "}
                      {agent.connectionStatus === "ONLINE"
                        ? t("online")
                        : t("offline")}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {loading && (
          <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
            {t("loading")}
          </p>
        )}
        {error && (
          <div className="p-3 text-sm" role="alert">
            <p>{t("loadError")}</p>
            <Button variant="link" onClick={refresh}>
              {t("retry")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
