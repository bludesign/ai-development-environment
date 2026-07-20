"use client";

import type { ReactNode } from "react";
import {
  Blocks,
  BellRing,
  ChartNoAxesCombined,
  Combine,
  Cpu,
  Database,
  GitPullRequest,
  GitBranch,
  HardDrive,
  Hammer,
  FolderGit2,
  House,
  MessageSquareText,
  MousePointerClick,
  PanelLeft,
  PanelRight,
  PlayCircle,
  Settings,
  Smartphone,
  ShieldCheck,
  Sparkles,
  TicketCheck,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";

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
import { Link, usePathname } from "@/i18n/navigation";
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
  const t = useTranslations("shell");
  const leftOpen = leftSidebar.isMobile
    ? leftSidebar.openMobile
    : leftSidebar.open;
  const rightOpen = rightSidebar.isMobile
    ? rightSidebar.openMobile
    : rightSidebar.open;

  return (
    <header className="sticky top-0 z-30 shrink-0 border-b bg-background/90 backdrop-blur-xl backdrop-saturate-150 supports-backdrop-filter:bg-background/70">
      <div aria-hidden="true" className="h-[env(safe-area-inset-top)]" />
      <div className="flex h-14 items-center justify-between pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1rem,env(safe-area-inset-left))]">
        <SidebarToggle
          expanded={leftOpen}
          hideLabel={t("hideNavigation")}
          onClick={leftSidebar.toggleSidebar}
          showLabel={t("showNavigation")}
          side="left"
        />
        <SidebarToggle
          expanded={rightOpen}
          hideLabel={t("hideNotifications")}
          onClick={rightSidebar.toggleSidebar}
          showLabel={t("showNotifications")}
          side="right"
        />
      </div>
    </header>
  );
}

function SidebarToggle({
  expanded,
  hideLabel,
  onClick,
  showLabel,
  side,
}: {
  expanded: boolean;
  hideLabel: string;
  onClick: () => void;
  showLabel: string;
  side: "left" | "right";
}) {
  const label = expanded ? hideLabel : showLabel;
  const Icon = side === "left" ? PanelLeft : PanelRight;

  return (
    <Button
      aria-expanded={expanded}
      aria-label={label}
      className="size-10 touch-manipulation"
      onClick={onClick}
      size="icon-lg"
      title={label}
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
      aria-label={label}
      className="ml-auto size-10 touch-manipulation md:hidden"
      onClick={() => setOpenMobile(false)}
      size="icon-lg"
      title={label}
      type="button"
      variant="ghost"
    >
      <X />
    </Button>
  );
}

function NavigationSidebar() {
  const t = useTranslations("shell");
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = usePathname();

  return (
    <Sidebar
      collapsible="offcanvas"
      mobileDescription={t("navigationDescription")}
      mobileTitle={t("navigation")}
      side="left"
    >
      <SidebarHeader className="border-b border-sidebar-border pt-[max(0.5rem,env(safe-area-inset-top))] md:pt-2">
        <div className="flex min-h-10 items-center gap-2 px-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Blocks className="size-4" />
          </div>
          <span className="text-sm leading-tight font-semibold">
            {t("productName")}
          </span>
          <MobileSidebarClose label={t("closeNavigation")} />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("dashboard")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/"}>
                  <Link
                    href="/"
                    onClick={() => {
                      if (isMobile) {
                        setOpenMobile(false);
                      }
                    }}
                  >
                    <House />
                    <span>{t("welcome")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/builds")}
                >
                  <Link
                    href="/builds"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Hammer />
                    <span>{t("builds")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/worktrees")}
                >
                  <Link
                    href="/worktrees"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <GitBranch />
                    <span>{t("worktrees")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/codebases")}
                >
                  <Link
                    href="/codebases"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <FolderGit2 />
                    <span>{t("codebases")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={
                    pathname.startsWith("/agents") ||
                    pathname.startsWith("/jobs")
                  }
                >
                  <Link
                    href="/agents"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Cpu />
                    <span>{t("agents")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/usage")}
                >
                  <Link
                    href="/usage"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <ChartNoAxesCombined />
                    <span>{t("usage")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("debugging")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/push-notifications")}
                >
                  <Link
                    href="/push-notifications"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <BellRing />
                    <span>{t("pushNotifications")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/console-logs")}
                >
                  <Link
                    href="/console-logs"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Terminal />
                    <span>{t("consoleLogs")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/analytics-events")}
                >
                  <Link
                    href="/analytics-events"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <MousePointerClick />
                    <span>{t("analyticsEvents")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/unified-events")}
                >
                  <Link
                    href="/unified-events"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Combine />
                    <span>{t("unifiedEvents")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("github")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/pull-requests")}
                >
                  <Link
                    href="/pull-requests"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <GitPullRequest />
                    <span>{t("pullRequests")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/actions")}
                >
                  <Link
                    href="/actions"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <PlayCircle />
                    <span>{t("actions")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/comments")}
                >
                  <Link
                    href="/comments"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <MessageSquareText />
                    <span>{t("comments")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("jira")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/jira/tickets")}
                >
                  <Link
                    href="/jira/tickets"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <TicketCheck />
                    <span>{t("tickets")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/jira/cache")}
                >
                  <Link
                    href="/jira/cache"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Database />
                    <span>{t("cache")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t("system")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/build-data")}
                >
                  <Link
                    href="/build-data"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <HardDrive />
                    <span>{t("buildData")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/provisioning-profiles")}
                >
                  <Link
                    href="/provisioning-profiles"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <ShieldCheck />
                    <span>{t("provisioningProfiles")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/devices")}
                >
                  <Link
                    href="/devices"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Smartphone />
                    <span>{t("devices")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/skills")}
                >
                  <Link
                    href="/skills"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Sparkles />
                    <span>{t("skills")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/tools")}
                >
                  <Link
                    href="/tools"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Wrench />
                    <span>{t("tools")}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith("/settings")}
                >
                  <Link
                    href="/settings"
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <Settings />
                    <span>{t("settings")}</span>
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
  const t = useTranslations("shell");

  return (
    <Sidebar
      collapsible="offcanvas"
      mobileDescription={t("notificationsDescription")}
      mobileTitle={t("notifications")}
      side="right"
    >
      <SidebarHeader className="border-b border-sidebar-border pt-[max(0.5rem,env(safe-area-inset-top))] md:pt-2">
        <div className="flex min-h-10 items-center px-2">
          <h2 className="text-sm font-semibold">{t("notifications")}</h2>
          <MobileSidebarClose label={t("closeNotifications")} />
        </div>
      </SidebarHeader>
      <SidebarContent />
    </Sidebar>
  );
}
