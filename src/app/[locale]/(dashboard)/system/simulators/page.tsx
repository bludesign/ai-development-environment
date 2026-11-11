import { SimulatorsPage } from "@/components/simulators/simulators-page";

export default async function SimulatorsRoute({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const { platform } = await searchParams;
  return (
    <SimulatorsPage
      initialPlatform={platform === "ANDROID" ? "ANDROID" : "APPLE"}
    />
  );
}
