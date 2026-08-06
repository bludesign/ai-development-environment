import { render, screen } from "@testing-library/react";
import { Children, type ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";

import RootLayout, { generateMetadata } from "@/app/[locale]/layout";

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  getTranslations: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist-sans" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
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

describe("localized root layout", () => {
  test("sets the document language without wrapping public routes in the dashboard shell", async () => {
    mocks.getMessages.mockResolvedValue({ shell: {} });

    const layout = await RootLayout({
      children: <p>Page content</p>,
      params: Promise.resolve({ locale: "es" }),
    });

    expect(layout.props.lang).toBe("es");
    const [head, body] = Children.toArray(
      layout.props.children,
    ) as ReactElement[];
    expect(head?.type).toBe("head");
    expect(
      (head?.props as { children: ReactElement }).children.props,
    ).toMatchObject({
      rel: "manifest",
      href: "/manifest.webmanifest",
      crossOrigin: "use-credentials",
    });
    expect(body?.type).toBe("body");
    render((body?.props as { children: React.ReactNode }).children);

    expect(screen.getByTestId("intl-provider")).toBeDefined();
    expect(screen.getByTestId("tooltip-provider")).toBeDefined();
    expect(screen.queryByTestId("app-shell")).toBeNull();
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
