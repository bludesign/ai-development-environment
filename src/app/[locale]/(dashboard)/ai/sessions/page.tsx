import { cookies } from "next/headers";

import { RunsPage } from "@/components/runs/runs-page";
import { parseRunFilters, runFilterCookieName } from "@/lib/run-filter-state";

export default async function SessionsRoute() {
  const cookieStore = await cookies();
  const initialFilters = parseRunFilters(
    cookieStore.get(runFilterCookieName("SESSION"))?.value,
  );

  return <RunsPage initialFilters={initialFilters} kind="SESSION" />;
}
