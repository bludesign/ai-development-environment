import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import RootLayout, { generateMetadata } from "@/app/[locale]/layout";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  getMessages: vi.fn(),
  getTranslations: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist-sans" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));

vi.mock("next-intl", () => ({
  defineRouting: <Config,>(config: Config) => config,
  hasLocale: (locales: readonly string[], locale: string | undefined) =>
    typeof locale === "string" && locales.includes(locale),
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="intl-provider">{children}</div>
  ),
}));

vi.mock("next-intl/server", () => ({
  getMessages: mocks.getMessages,
  getTranslations: mocks.getTranslations,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-provider">{children}</div>
  ),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({
    children,
    leftDefaultOpen,
    rightDefaultOpen,
  }: {
    children: React.ReactNode;
    leftDefaultOpen: boolean;
    rightDefaultOpen: boolean;
  }) => (
    <div
      data-testid="app-shell"
      data-left-open={leftDefaultOpen}
      data-right-open={rightDefaultOpen}
    >
      {children}
    </div>
  ),
}));

describe("localized root layout", () => {
  test("sets the document language and preserves sidebar cookie defaults", async () => {
    mocks.cookies.mockResolvedValue({
      get: (name: string) => {
        if (name === LEFT_SIDEBAR_COOKIE) return { value: "false" };
        if (name === RIGHT_SIDEBAR_COOKIE) return { value: "true" };
        return undefined;
      },
    });
    mocks.getMessages.mockResolvedValue({ shell: {} });

    const layout = await RootLayout({
      children: <p>Page content</p>,
      params: Promise.resolve({ locale: "es" }),
    });

    expect(layout.props.lang).toBe("es");
    render(layout.props.children.props.children);

    expect(screen.getByTestId("intl-provider")).toBeDefined();
    expect(screen.getByTestId("tooltip-provider")).toBeDefined();
    expect(screen.getByTestId("app-shell").dataset.leftOpen).toBe("false");
    expect(screen.getByTestId("app-shell").dataset.rightOpen).toBe("true");
    expect(screen.getByText("Page content")).toBeDefined();
  });

  test("generates metadata in the requested locale", async () => {
    mocks.getTranslations.mockResolvedValue((key: string) => {
      const translations: Record<string, string> = {
        title: "AI Development Environment",
        description:
          "Un entorno de desarrollo centrado en la inteligencia artificial.",
      };
      return translations[key];
    });

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "es" }),
    });

    expect(mocks.getTranslations).toHaveBeenCalledWith({
      locale: "es",
      namespace: "metadata",
    });
    expect(metadata.title).toBe("AI Development Environment");
    expect(metadata.description).toBe(
      "Un entorno de desarrollo centrado en la inteligencia artificial.",
    );
  });
});
