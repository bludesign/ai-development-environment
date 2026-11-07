import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const signInSocial = vi.hoisted(() => vi.fn());
vi.mock("@/services/auth/auth-client", () => ({
  authClient: { signIn: { social: signInSocial } },
}));

import { AuthForm } from "./auth-form";

const nearbyReturnTo =
  "/api/auth/mobile/complete?callback=aide-auth%3A%2F%2Fcallback&state=client&code_challenge=challenge&browser_state=browser";

beforeEach(() => {
  signInSocial.mockReset().mockResolvedValue({ error: { message: "Failed" } });
});

test.each([
  ["sign-in", nearbyReturnTo, nearbyReturnTo],
  ["register", nearbyReturnTo, nearbyReturnTo],
  ["sign-in", "/en/dashboard/action-center", undefined],
] as const)(
  "sets the OAuth error callback for %s to %s only for nearby authentication",
  async (intent, returnTo, errorCallbackURL) => {
    render(
      <AuthForm
        configuration={{
          mode: "oidc",
          provider: { id: "example", name: "Example" },
          registration: { enabled: true, setupRequired: false },
        }}
        intent={intent}
        returnTo={returnTo}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Example" }),
    );
    await screen.findByText("Failed");

    expect(signInSocial).toHaveBeenCalledExactlyOnceWith({
      provider: "example",
      callbackURL: returnTo,
      errorCallbackURL,
      requestSignUp: intent === "register",
    });
  },
);
