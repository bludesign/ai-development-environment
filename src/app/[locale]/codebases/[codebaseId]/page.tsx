import { CodebaseDetailPage } from "@/components/codebases/codebase-detail-page";

export default async function CodebaseDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; codebaseId: string }>;
}) {
  const { codebaseId } = await params;
  return <CodebaseDetailPage codebaseId={codebaseId} key={codebaseId} />;
}
