export type ApplePortalResource = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
};

export function eligiblePortalDeviceIds(
  devices: ApplePortalResource[],
  profileType: string,
): string[] {
  if (!["IOS_APP_DEVELOPMENT", "IOS_APP_ADHOC"].includes(profileType)) {
    return [];
  }
  return devices
    .filter(
      (device) =>
        device.attributes.status === "ENABLED" &&
        device.attributes.platform === "IOS",
    )
    .map((device) => device.id);
}
