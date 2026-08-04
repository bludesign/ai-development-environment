import { AuthForm } from "@/components/auth/auth-form";
import { getAuthRuntimeConfig, getRegistrationStatus } from "@/services/auth";

export default async function RegisterPage() {
  const [runtime, registration] = await Promise.all([
    Promise.resolve(getAuthRuntimeConfig()),
    getRegistrationStatus(),
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
    />
  );
}
