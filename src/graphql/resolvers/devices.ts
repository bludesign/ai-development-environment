import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  AppStoreConnectSettingsInput,
  IosDevicesService,
  IosDeviceStatus,
} from "@/services/ios-devices";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

const deviceViewResolvers = {
  maskedUdid: (value: { udid: string }) => {
    if (value.udid.length <= 8) return "••••••••";
    return `${value.udid.slice(0, 4)}••••${value.udid.slice(-4)}`;
  },
  lastIpAddress: (value: { ipObservations?: Array<{ ipAddress: string }> }) =>
    value.ipObservations?.[0]?.ipAddress ?? null,
  registeredAt: (value: { registeredAt: Date | null }) =>
    iso(value.registeredAt),
  lastSeenAt: (value: { lastSeenAt: Date | null }) => iso(value.lastSeenAt),
  createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
};

export const createIosDeviceResolvers = (service: IosDevicesService) => ({
  IosDevice: deviceViewResolvers,
  IosDeviceSummary: deviceViewResolvers,
  IosDeviceEnrollment: {
    expiresAt: (value: { expiresAt: Date }) => value.expiresAt.toISOString(),
    downloadedAt: (value: { downloadedAt: Date | null }) =>
      iso(value.downloadedAt),
    consumedAt: (value: { consumedAt: Date | null }) => iso(value.consumedAt),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  IosDeviceIpObservation: {
    observedAt: (value: { observedAt: Date }) => value.observedAt.toISOString(),
  },
  Query: {
    iosDevices: (
      _root: unknown,
      { status }: { status?: IosDeviceStatus | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.devices(status);
    },
    iosDevice: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.device(id);
    },
    iosDeviceSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getSettings();
    },
  },
  Mutation: {
    renameIosDevice: (
      _root: unknown,
      { id, displayName }: { id: string; displayName: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.renameDevice(id, displayName);
    },
    rejectIosDevice: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.rejectDevice(id);
    },
    deleteIosDevice: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteDevice(id);
    },
    registerIosDevice: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.registerDevice(id);
    },
    saveIosProfileSettings: (
      _root: unknown,
      {
        input,
      }: { input: { organizationName: string; profileIdentifier: string } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveProfileSettings(input);
    },
    regenerateIosProfileSigner: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.regenerateProfileSignerView();
    },
    saveAppStoreConnectSettings: (
      _root: unknown,
      { input }: { input: AppStoreConnectSettingsInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveAppStoreConnectSettings(input);
    },
    testAppStoreConnectSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.testAppStoreConnectSettings();
    },
    clearAppStoreConnectSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearAppStoreConnectSettings();
    },
  },
  Subscription: {
    iosDevicesChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
      resolve: (payload: { id: string | null }) => payload,
    },
  },
});
