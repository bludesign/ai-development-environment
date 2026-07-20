import { DeviceDetailPage } from "@/components/devices/device-detail-page";

export default async function DeviceDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DeviceDetailPage id={id} />;
}
