import { headers } from "next/headers";
import { BuildConfigurationDetail } from "@/components/builds/build-configurations";
import { resolvePublicOrigin } from "@/lib/public-origin";

export default async function ConfigurationRoute({
  params,
}: {
  params: Promise<{ configurationId: string }>;
}) {
  const { configurationId } = await params;
  return (
    <BuildConfigurationDetail
      id={configurationId}
      publicOrigin={resolvePublicOrigin(await headers())}
    />
  );
}
