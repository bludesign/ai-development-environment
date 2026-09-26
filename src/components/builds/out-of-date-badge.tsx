"use client";

import { ChevronDown, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useRebuildBuild } from "./rebuild-button";

export function OutOfDateBadge(props: Parameters<typeof useRebuildBuild>[0]) {
  const t = useTranslations("builds");
  const { rebuild, rebuilding } = useRebuildBuild(props);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className="border-amber-500/40 text-amber-700 dark:text-amber-300"
        >
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {t("outOfDate")} <ChevronDown className="size-3" />
          </button>
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuItem disabled={rebuilding} onSelect={() => void rebuild()}>
          {rebuilding ? <Spinner /> : <RotateCcw />} {t("rebuild")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
