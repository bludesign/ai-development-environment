import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchGitHubProfile } from "./github-profile";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGitHubProfile", () => {
  test("uses the primary GitHub email when the profile email is private", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: 42,
          login: "octocat",
          name: null,
          email: null,
          avatar_url: "https://avatars.example/octocat",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            email: "secondary@example.com",
            primary: false,
            verified: true,
          },
          {
            email: "octocat@example.com",
            primary: true,
            verified: true,
          },
        ]),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      fetchGitHubProfile("https://api.github.com/user", "access-token"),
    ).resolves.toMatchObject({
      id: 42,
      name: "octocat",
      email: "octocat@example.com",
      emailVerified: true,
      image: "https://avatars.example/octocat",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/user/emails",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
        }),
      }),
    );
  });

  test("preserves a public profile email when the email endpoint fails", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: 42,
          login: "octocat",
          name: "The Octocat",
          email: "public@example.com",
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      fetchGitHubProfile("https://github.example/api/v3/user", "token"),
    ).resolves.toMatchObject({
      name: "The Octocat",
      email: "public@example.com",
      emailVerified: false,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://github.example/api/v3/user/emails",
      expect.any(Object),
    );
  });

  test("returns null when GitHub rejects the profile request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    await expect(
      fetchGitHubProfile("https://api.github.com/user", "bad-token"),
    ).resolves.toBeNull();
  });

  test("returns null when the profile request cannot reach GitHub", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(
      fetchGitHubProfile("https://api.github.com/user", "access-token"),
    ).resolves.toBeNull();
  });
});
