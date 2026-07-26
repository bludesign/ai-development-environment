"use client";

import { ListTodo } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";

import { ActionCenterItem } from "./action-center-item";
import { useOptionalActionCenter } from "./action-center-provider";

export function MiniActionCenter() {
  const t = useTranslations("actionCenter");
  const center = useOptionalActionCenter();
  if (!center) return null;
  const { items, totalCount, loading, loadingMore, hasMore, loadMore } = center;

  return (
    <section
      aria-label={t("miniLabel")}
      className="flex h-full min-h-0 flex-col bg-sidebar"
    >
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-2.5">
        <ListTodo className="size-4" />
        <Link
          className="min-w-0 flex-1 truncate text-xs font-semibold hover:underline"
          href="/action-center"
        >
          {t("title")}
        </Link>
        <Badge className="h-5 min-w-5 px-1.5 text-[10px]" variant="secondary">
          {totalCount}
        </Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        {loading && items.length === 0 ? (
          <div className="flex justify-center p-5">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t("miniEmpty")}
          </p>
        ) : (
          items.map((item) => (
            <ActionCenterItem compact item={item} key={item.key} />
          ))
        )}
        {hasMore && (
          <div className="p-2">
            <Button
              className="w-full"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              size="xs"
              variant="ghost"
            >
              {loadingMore && <Spinner />} {t("loadMore")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
