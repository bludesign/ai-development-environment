import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";

import { AppShell } from "@/components/app-shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Development Environment",
  description: "An AI-focused development environment.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#252525" },
  ],
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const leftDefaultOpen =
    cookieStore.get(LEFT_SIDEBAR_COOKIE)?.value !== "false";
  const rightDefaultOpen =
    cookieStore.get(RIGHT_SIDEBAR_COOKIE)?.value !== "false";

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-dvh overflow-hidden">
        <TooltipProvider>
          <AppShell
            leftDefaultOpen={leftDefaultOpen}
            rightDefaultOpen={rightDefaultOpen}
          >
            {children}
          </AppShell>
        </TooltipProvider>
      </body>
    </html>
  );
}
