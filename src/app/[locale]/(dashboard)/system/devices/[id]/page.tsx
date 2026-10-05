import { DeviceDetailPage } from "@/components/devices/device-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function DeviceDetailRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <DeviceDetailPage id={id} />
      <WorkflowResourcePanel
        resourceId={id}
        resourceKind="IOS_DEVICE"
        sessionData={{ device: { id } }}
      />
    </div>
  );
}
