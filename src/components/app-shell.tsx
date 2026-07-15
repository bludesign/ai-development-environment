"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Blocks, House, PanelLeft, PanelRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";

type AppShellProps = {
  children: ReactNode;
  leftDefaultOpen: boolean;
  rightDefaultOpen: boolean;
};

type SidebarControls = {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
  toggleSidebar: () => void;
};

export function AppShell({
  children,
  leftDefaultOpen,
  rightDefaultOpen,
}: AppShellProps) {
  return (
    <SidebarProvider
      cookieName={LEFT_SIDEBAR_COOKIE}
      defaultOpen={leftDefaultOpen}
      className="h-dvh min-h-0 overflow-hidden"
    >
      <NavigationSidebar />
      <RightSidebarLayout rightDefaultOpen={rightDefaultOpen}>
        {children}
      </RightSidebarLayout>
    </SidebarProvider>
  );
}

function RightSidebarLayout({
  children,
  rightDefaultOpen,
}: {
  children: ReactNode;
  rightDefaultOpen: boolean;
}) {
  const leftSidebar = useSidebar();

  return (
    <SidebarProvider
      cookieName={RIGHT_SIDEBAR_COOKIE}
      defaultOpen={rightDefaultOpen}
      keyboardShortcut={null}
      className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <ShellContent leftSidebar={leftSidebar}>{children}</ShellContent>
    </SidebarProvider>
  );
}

function ShellContent({
  children,
  leftSidebar,
}: {
  children: ReactNode;
  leftSidebar: SidebarControls;
}) {
  const rightSidebar = useSidebar();

  return (
    <>
      <div
        className="relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col bg-background"
        data-slot="sidebar-inset"
      >
        <AppHeader leftSidebar={leftSidebar} rightSidebar={rightSidebar} />
        <main className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
          <div className="w-full p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6 sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            {children}
          </div>
        </main>
      </div>
      <NotificationsSidebar />
    </>
  );
}

function AppHeader({
  leftSidebar,
  rightSidebar,
}: {
  leftSidebar: SidebarControls;
  rightSidebar: SidebarControls;
}) {
  const leftOpen = leftSidebar.isMobile
    ? leftSidebar.openMobile
    : leftSidebar.open;
  const rightOpen = rightSidebar.isMobile
    ? rightSidebar.openMobile
    : rightSidebar.open;

  return (
    <header className="sticky top-0 z-30 shrink-0 border-b bg-background/90 backdrop-blur-xl backdrop-saturate-150 supports-backdrop-filter:bg-background/70">
      <div aria-hidden="true" className="h-[env(safe-area-inset-top)]" />
      <div className="grid h-14 grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1rem,env(safe-area-inset-left))]">
        <SidebarToggle
          expanded={leftOpen}
          label="navigation"
          onClick={leftSidebar.toggleSidebar}
          side="left"
        />
        <p className="truncate px-3 text-center text-sm font-medium">Welcome</p>
        <SidebarToggle
          expanded={rightOpen}
          label="notifications"
          onClick={rightSidebar.toggleSidebar}
          side="right"
        />
      </div>
    </header>
  );
}

function SidebarToggle({
  expanded,
  label,
  onClick,
  side,
}: {
  expanded: boolean;
  label: string;
  onClick: () => void;
  side: "left" | "right";
}) {
  const action = expanded ? "Hide" : "Show";
  const Icon = side === "left" ? PanelLeft : PanelRight;

  return (
    <Button
      aria-expanded={expanded}
      aria-label={`${action} ${label}`}
      className="size-10 touch-manipulation"
      onClick={onClick}
      size="icon-lg"
      title={`${action} ${label}`}
      type="button"
      variant="ghost"
    >
      <Icon />
    </Button>
  );
}

function MobileSidebarClose({ label }: { label: string }) {
  const { setOpenMobile } = useSidebar();

  return (
    <Button
      aria-label={`Close ${label}`}
      className="ml-auto size-10 touch-manipulation md:hidden"
      onClick={() => setOpenMobile(false)}
      size="icon-lg"
      title={`Close ${label}`}
      type="button"
      variant="ghost"
    >
      <X />
    </Button>
  );
}

function NavigationSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <Sidebar
      collapsible="offcanvas"
      mobileDescription="Primary navigation for AI Development Environment."
      mobileTitle="Navigation"
      side="left"
    >
      <SidebarHeader className="border-b border-sidebar-border pt-[max(0.5rem,env(safe-area-inset-top))] md:pt-2">
        <div className="flex min-h-10 items-center gap-2 px-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Blocks className="size-4" />
          </div>
          <span className="text-sm leading-tight font-semibold">
            AI Development Environment
          </span>
          <MobileSidebarClose label="navigation" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Dashboard</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive>
                  <Link
                    href="/"
                    onClick={() => {
                      if (isMobile) {
                        setOpenMobile(false);
                      }
                    }}
                  >
                    <House />
                    <span>Welcome</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function NotificationsSidebar() {
  return (
    <Sidebar
      collapsible="offcanvas"
      mobileDescription="Notification updates and alerts."
      mobileTitle="Notifications"
      side="right"
    >
      <SidebarHeader className="border-b border-sidebar-border pt-[max(0.5rem,env(safe-area-inset-top))] md:pt-2">
        <div className="flex min-h-10 items-center px-2">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <MobileSidebarClose label="notifications" />
        </div>
      </SidebarHeader>
      <SidebarContent />
    </Sidebar>
  );
}
