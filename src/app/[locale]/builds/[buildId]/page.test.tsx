import { headers } from "next/headers";
import { afterEach, describe, expect, test, vi } from "vitest";

import BuildDetailRoute from "./page";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));
vi.mock("@/components/builds/build-detail-page", () => ({
  BuildDetailPage: () => null,
}));

const headersMock = vi.mocked(headers);

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL;
  vi.clearAllMocks();
});

describe("BuildDetailRoute", () => {
  test("passes the configured public origin to the install controls", async () => {
    process.env.PUBLIC_BASE_URL = "https://ota.example.com/install";
    headersMock.mockResolvedValue(
      new Headers({ host: "internal.example.test" }) as never,
    );

    const element = await BuildDetailRoute({
      params: Promise.resolve({ locale: "en", buildId: "build-1" }),
    });
    const props = element.props as {
      buildId: string;
      publicOrigin: { origin: string; secure: boolean; source: string };
    };

    expect(props).toMatchObject({
      buildId: "build-1",
      publicOrigin: {
        origin: "https://ota.example.com",
        secure: true,
        source: "env",
      },
    });
  });
});
