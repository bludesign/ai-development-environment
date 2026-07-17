"use client";

import { UserRound } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export function JiraPersonAvatar({
  avatarUrl,
  compact = false,
}: {
  avatarUrl: string | null;
  compact?: boolean;
}) {
  return (
    <Avatar aria-hidden="true" className={compact ? "size-4" : "size-5"}>
      <AvatarImage alt="" src={avatarUrl ?? undefined} />
      <AvatarFallback>
        <UserRound className={compact ? "size-3" : "size-3.5"} />
      </AvatarFallback>
    </Avatar>
  );
}

export function JiraUser({
  avatarUrl,
  className,
  compact = false,
  name,
  nameClassName,
}: {
  avatarUrl: string | null;
  className?: string;
  compact?: boolean;
  name: string;
  nameClassName?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <JiraPersonAvatar avatarUrl={avatarUrl} compact={compact} />
      <span className={cn("min-w-0", nameClassName)}>{name}</span>
    </span>
  );
}
