import { ProvisioningProfileDetailPage } from "@/components/signing-assets/provisioning-profile-detail-page";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";

export default async function ProvisioningProfileDetailRoute({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;
  const id = decodeURIComponent(profileId);
  return (
    <div className="space-y-6 [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none">
      <ProvisioningProfileDetailPage id={id} />
      <WorkflowResourcePanel
        resourceId={id}
        resourceKind="SIGNING_PROFILE"
        sessionData={{ signingProfile: { id } }}
      />
    </div>
  );
}
