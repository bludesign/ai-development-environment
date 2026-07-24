import { headers } from "next/headers";

import { BuildDetailPage } from "@/components/builds/build-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";
import { resolvePublicOrigin } from "@/lib/public-origin";

export default async function BuildDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; buildId: string }>;
}) {
  const { buildId } = await params;
  const publicOrigin = resolvePublicOrigin(await headers());
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <BuildDetailPage buildId={buildId} publicOrigin={publicOrigin} />
      <WorkflowResourcePanel
        resourceId={buildId}
        resourceKind="BUILD"
        sessionData={{ build: { id: buildId } }}
      />
    </div>
  );
}
