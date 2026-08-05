import { AuthForm } from "@/components/auth/auth-form";
import { getAuthRuntimeConfig, getRegistrationStatus } from "@/services/auth";

export default async function SignInPage({
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
      intent="sign-in"
      returnTo={query.returnTo}
    />
  );
}
