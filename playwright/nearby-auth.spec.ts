import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

import { screenshotSessionToken } from "../scripts/mock-data/auth";

test("nearby sign-in returns an independent TV credential without a cookie", async ({
  baseURL,
  playwright,
  request,
}) => {
  const phone = await playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { authorization: `Bearer ${screenshotSessionToken}` },
  });
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");

  try {
    const start = await phone.get("/api/auth/mobile/start", {
      params: {
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      },
      maxRedirects: 0,
    });
    expect(start.status()).toBe(302);
    const completion = new URL(start.headers().location, start.url());
    expect(completion.pathname).toBe("/api/auth/mobile/complete");

    const complete = await phone.get(completion.href, { maxRedirects: 0 });
    expect(complete.status()).toBe(302);
    const callback = new URL(complete.headers().location);
    expect(callback.protocol).toBe("aide-auth:");
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const redemption = await request.post("/api/auth/mobile/redeem", {
      data: { code, code_verifier: verifier },
    });
    await expect(redemption).toBeOK();
    const { token } = await redemption.json();
    expect(token).toEqual(expect.any(String));
    expect(token).not.toBe(screenshotSessionToken);

    const televisionHeaders = { authorization: `Bearer ${token}` };
    try {
      expect(redemption.headers()["set-cookie"]).toBeUndefined();
      const tv = await request.get("/api/auth/get-session", {
        headers: televisionHeaders,
      });
      await expect(tv).toBeOK();
      expect(await tv.json()).toMatchObject({ session: { token } });
    } finally {
      // Node fetch has no cookie jar, so cleanup can only revoke the TV token.
      const signOutURL = new URL("/api/auth/sign-out", redemption.url());
      const signOut = await fetch(signOutURL, {
        method: "POST",
        headers: {
          ...televisionHeaders,
          "content-type": "application/json",
          origin: signOutURL.origin,
        },
        body: "{}",
      });
      expect(signOut.status).toBe(200);
    }
  } finally {
    await phone.dispose();
  }
});
