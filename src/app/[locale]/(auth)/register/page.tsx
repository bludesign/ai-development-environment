import { AuthForm } from "@/components/auth/auth-form";
import { getAuthRuntimeConfig, getRegistrationStatus } from "@/services/auth";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const [runtime, registration, query] = await Promise.all([
    Promise.resolve(getAuthRuntimeConfig()),
    getRegistrationStatus(),
    searchParams,
  ]);
  return (
    <AuthForm
      configuration={{
        mode: runtime.mode,
        registration,
        provider: runtime.provider
          ? {
              id: runtime.provider.providerId,
              name: runtime.provider.displayName,
            }
          : null,
      }}
      intent="register"
      returnTo={query.returnTo}
    />
  );
}
