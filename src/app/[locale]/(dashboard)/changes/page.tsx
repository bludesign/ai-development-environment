import { DiffsPage } from "@/components/diffs/diffs-page";

/** Collapses a possibly-repeated query parameter to its first value. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DiffsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <DiffsPage
      initial={{
        worktreeId: first(params.worktree),
        scope: first(params.scope),
        path: first(params.path),
        commitSha: first(params.commit),
        coverageReportId: first(params.coverage),
        mode: first(params.mode),
        wrap: first(params.wrap),
      }}
    />
  );
}
