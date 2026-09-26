import { BuildsPage } from "@/components/builds/builds-page";

import { headers } from "next/headers";
import { resolvePublicOrigin } from "@/lib/public-origin";

export default async function BuildsRoute() {
  return <BuildsPage publicOrigin={resolvePublicOrigin(await headers())} />;
}
