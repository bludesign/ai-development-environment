import { BuildsPage } from "@/components/builds/builds-page";

import { headers } from "next/headers";
import { resolvePublicOrigin } from "@/lib/public-origin";

export default async function BuildsRoute({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { view } = await searchParams;
  const initialTab =
    view === "configurations" || view === "scripts" ? view : "history";
  return (
    <BuildsPage
      key={initialTab}
      initialTab={initialTab}
      publicOrigin={resolvePublicOrigin(await headers())}
    />
  );
}
