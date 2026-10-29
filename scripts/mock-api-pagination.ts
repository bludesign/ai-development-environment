export function paginateMockRecords<T>(
  records: readonly T[],
  search: URLSearchParams,
) {
  const page = Math.max(1, Number(search.get("page")) || 1);
  const perPage = Math.max(
    1,
    Math.min(100, Number(search.get("per_page")) || 30),
  );
  const offset = (page - 1) * perPage;
  return {
    items: records.slice(offset, offset + perPage),
    total: records.length,
    headers: {
      "x-total": String(records.length),
      "x-page": String(page),
      "x-per-page": String(perPage),
      "x-next-page": offset + perPage < records.length ? String(page + 1) : "",
    },
  };
}

export function mockActionsRuns<
  T extends {
    status: string;
    conclusion: string | null;
    head_branch: string;
    pull_requests: unknown[];
  },
>(runs: readonly T[], search: URLSearchParams) {
  const status = search.get("status");
  const branch = search.get("branch");
  const filtered = runs.filter(
    (run) =>
      (!status || run.status === status || run.conclusion === status) &&
      (!branch || run.head_branch === branch),
  );
  const page = paginateMockRecords(filtered, search);
  return {
    total_count: page.total,
    workflow_runs:
      search.get("exclude_pull_requests") === "true"
        ? page.items.map((run) => ({ ...run, pull_requests: [] }))
        : page.items,
  };
}
