import {
  AppDetailPage,
  type AppDetailView,
} from "@/components/apps/app-detail-page";

const VIEWS = new Set<AppDetailView>([
  "overview",
  "repositories",
  "worktrees",
  "plans",
  "sessions",
  "builds",
]);

export default async function AppDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ appId: string }>;
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const [{ appId }, query] = await Promise.all([params, searchParams]);
  const requested = Array.isArray(query.view) ? query.view[0] : query.view;
  const view = VIEWS.has(requested as AppDetailView)
    ? (requested as AppDetailView)
    : "overview";
  return <AppDetailPage appId={appId} view={view} />;
}
