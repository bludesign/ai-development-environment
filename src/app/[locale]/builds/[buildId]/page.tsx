import { headers } from "next/headers";

import { BuildDetailPage } from "@/components/builds/build-detail-page";
import { resolvePublicOrigin } from "@/lib/public-origin";

export default async function BuildDetailRoute({
  params,
}: {
  params: Promise<{ locale: string; buildId: string }>;
}) {
  const { buildId } = await params;
  const publicOrigin = resolvePublicOrigin(await headers());
  return (
    <BuildDetailPage
      buildId={buildId}
      key={buildId}
      publicOrigin={publicOrigin}
    />
  );
}
