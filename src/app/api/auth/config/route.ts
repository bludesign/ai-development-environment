import { getAuthRuntimeConfig, getRegistrationStatus } from "@/services/auth";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const [configuration, registration] = await Promise.all([
    Promise.resolve(getAuthRuntimeConfig()),
    getRegistrationStatus(),
  ]);
  return Response.json({
    mode: configuration.mode,
    registration,
    provider: configuration.provider
      ? {
          id: configuration.provider.providerId,
          name: configuration.provider.displayName,
        }
      : null,
  });
}
