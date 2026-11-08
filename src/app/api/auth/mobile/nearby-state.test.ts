import { describe, expect, test } from "vitest";

import {
  clearedNearbyStateCookie,
  MOBILE_NEARBY_STATE_COOKIE,
  nearbyStateCookie,
  readNearbyState,
} from "./nearby-state";
import { MOBILE_OAUTH_STATE_COOKIE } from "./oauth/state";

describe("nearby browser state", () => {
  test("stays distinct from legacy OAuth state and expires after ten minutes", () => {
    const request = new Request(
      "https://control.example/api/auth/mobile/start",
    );
    const cookie = nearbyStateCookie("state", request, false);
    expect(cookie).toContain(`${MOBILE_NEARBY_STATE_COOKIE}=state;`);
    expect(cookie).toContain("Path=/api/auth/mobile;");
    expect(cookie).toContain("Max-Age=600;");
    expect(cookie).toContain("HttpOnly; SameSite=Lax; Secure");
    expect(clearedNearbyStateCookie(request, false)).toContain("Max-Age=0;");
    expect(
      readNearbyState(
        new Headers({ cookie: `${MOBILE_OAUTH_STATE_COOKIE}=legacy` }),
      ),
    ).toBeNull();
    expect(
      readNearbyState(
        new Headers({
          cookie: `${MOBILE_OAUTH_STATE_COOKIE}=legacy; ${MOBILE_NEARBY_STATE_COOKIE}=nearby`,
        }),
      ),
    ).toBe("nearby");
  });

  test("follows forwarded HTTPS only when proxy headers are trusted", () => {
    const request = new Request("http://internal:3000/api/auth/mobile/start", {
      headers: {
        "x-forwarded-host": "control.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(nearbyStateCookie("state", request, true)).toContain("Secure");
    expect(nearbyStateCookie("state", request, false)).not.toContain("Secure");
  });
});
