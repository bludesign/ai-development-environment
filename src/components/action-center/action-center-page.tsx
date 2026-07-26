"use client";

import { ListTodo, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import { ActionCenterItem } from "./action-center-item";
import { useActionCenter } from "./action-center-provider";

export function ActionCenterPage() {
  const t = useTranslations("actionCenter");
  const {
    items,
    totalCount,
    needsAttentionCount,
    activeCount,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    refresh,
  } = useActionCenter();
  const attention = items.filter(({ reason }) => reason !== "ACTIVE");
  const active = items.filter(({ reason }) => reason === "ACTIVE");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button
          aria-label={t("refresh")}
          disabled={loading}
          onClick={() => void refresh()}
          size="icon"
          title={t("refresh")}
          variant="outline"
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          {t("totalCount", { count: totalCount })}
        </Badge>
        <Badge className="border-amber-500/40" variant="outline">
          {t("attentionCount", { count: needsAttentionCount })}
        </Badge>
        <Badge variant="secondary">
          {t("activeCount", { count: activeCount })}
        </Badge>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && items.length === 0 ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListTodo />
            </EmptyMedia>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="attention-heading">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold" id="attention-heading">
                {t("needsAttention")}
              </h2>
              <Badge variant="outline">{needsAttentionCount}</Badge>
            </div>
            {attention.length ? (
              <div
                className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,32rem),1fr))] items-stretch gap-3"
                data-slot="action-center-items"
              >
                {attention.map((item) => (
                  <ActionCenterItem item={item} key={item.key} />
                ))}
              </div>
            ) : needsAttentionCount === 0 ? (
              <p className="rounded-lg border p-5 text-sm text-muted-foreground">
                {t("noAttention")}
              </p>
            ) : null}
          </section>

          <section className="space-y-3" aria-labelledby="active-heading">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold" id="active-heading">
                {t("active")}
              </h2>
              <Badge variant="secondary">{activeCount}</Badge>
            </div>
            {active.length ? (
              <div
                className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,32rem),1fr))] items-stretch gap-3"
                data-slot="action-center-items"
              >
                {active.map((item) => (
                  <ActionCenterItem item={item} key={item.key} />
                ))}
              </div>
            ) : activeCount === 0 ? (
              <p className="rounded-lg border p-5 text-sm text-muted-foreground">
                {t("noActive")}
              </p>
            ) : null}
          </section>
        </>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button
            disabled={loadingMore}
            onClick={() => void loadMore()}
            variant="outline"
          >
            {loadingMore && <Spinner />} {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
