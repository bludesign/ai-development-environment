import { ProvisioningProfileDetailPage } from "@/components/signing-assets/provisioning-profile-detail-page";

export default async function ProvisioningProfileDetailRoute({
  params,
}: {
  params: Promise<{ profileId: string }>;
}) {
  const { profileId } = await params;
  return <ProvisioningProfileDetailPage id={decodeURIComponent(profileId)} />;
}
