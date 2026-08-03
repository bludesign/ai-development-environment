import { RunStartPage } from "@/components/runs/run-start-page";

export default async function RunNewRoute({
  searchParams,
}: {
  searchParams: Promise<{
    kind?: string | string[];
    draft?: string | string[];
    worktree?: string | string[];
  }>;
}) {
  const values = await searchParams;
  const kindValue = Array.isArray(values.kind) ? values.kind[0] : values.kind;
  const draftValue = Array.isArray(values.draft)
    ? values.draft[0]
    : values.draft;
  const worktreeValue = Array.isArray(values.worktree)
    ? values.worktree[0]
    : values.worktree;
  return (
    <RunStartPage
      draftId={draftValue ?? null}
      initialKind={kindValue?.toLowerCase() === "session" ? "SESSION" : "PLAN"}
      initialWorktreeId={worktreeValue ?? null}
    />
  );
}
