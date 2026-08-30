"use client";

import {
  Braces,
  History,
  Library,
  RadioTower,
  ShieldAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

const NAVIGATION: Array<{
  href: string;
  label: string;
  icon: typeof RadioTower;
  exact?: boolean;
}> = [
  { href: "/sse", label: "Endpoints", icon: RadioTower, exact: true },
  { href: "/sse/breakpoints", label: "Breakpoints", icon: ShieldAlert },
  { href: "/sse/storage", label: "Script storage", icon: Braces },
  { href: "/sse/history", label: "History", icon: History },
] as const;

export function SsePageShell({
  title,
  description,
  children,
  action,
  badge,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  badge?: string;
}) {
  const pathname = usePathname();
  return (
    <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {badge ? <Badge variant="secondary">{badge}</Badge> : null}
          </div>
          <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        {action}
      </div>
      <nav
        aria-label="SSE sections"
        className="flex flex-wrap gap-2 border-b pb-3"
      >
        {NAVIGATION.map((item) => {
          const active = item.exact
            ? pathname === item.href ||
              /^\/sse\/(?:new|(?!(?:breakpoints|storage|history)$)[^/]+)$/.test(
                pathname,
              )
            : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Button
              asChild
              key={item.href}
              size="sm"
              variant={active ? "secondary" : "ghost"}
            >
              <Link aria-current={active ? "page" : undefined} href={item.href}>
                <Icon /> {item.label}
              </Link>
            </Button>
          );
        })}
      </nav>
      <div className={cn("min-w-0", pathname === "/sse" && "space-y-4")}>
        {children}
      </div>
    </section>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  return (
    <Badge
      variant={
        mode === "FORWARD"
          ? "success"
          : mode === "MOCK"
            ? "secondary"
            : "outline"
      }
    >
      {mode === "BREAKPOINT" ? (
        <ShieldAlert />
      ) : mode === "MOCK" ? (
        <Library />
      ) : (
        <RadioTower />
      )}
      {mode.toLocaleLowerCase().replace(/^./, (value) => value.toUpperCase())}
    </Badge>
  );
}
