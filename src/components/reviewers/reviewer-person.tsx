import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

import type { CodeReviewerPerson } from "./types";

export function ReviewerPerson({ person }: { person: CodeReviewerPerson }) {
  return (
    <>
      <Avatar size="sm">
        {person.avatarUrl && <AvatarImage alt="" src={person.avatarUrl} />}
        <AvatarFallback>
          {(person.name || person.username).slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {person.name || person.username}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          @{person.username}
        </span>
      </span>
    </>
  );
}
