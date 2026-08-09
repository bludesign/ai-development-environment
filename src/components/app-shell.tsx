"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Blocks, LogOut, PanelLeft, PanelRight, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ActionCenterProvider } from "@/components/action-center/action-center-provider";
import { SidebarStatusFooter } from "@/components/disk-space/sidebar-status";
import { GitHubPipelineStatusProvider } from "@/components/github/pipeline-status-provider";
import { GlobalSearch } from "@/components/global-search";
import { NotificationsSidebar } from "@/components/notifications/notifications-sidebar";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
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
import {
  APP_DESTINATIONS,
  NAVIGATION_SECTIONS,
  destinationActive,
  destinationVisible,
  type NavigationFeatures,
} from "@/lib/app-destinations";
import { buildAppBreadcrumbs, type AppBreadcrumb } from "@/lib/breadcrumbs";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { LEFT_SIDEBAR_COOKIE, RIGHT_SIDEBAR_COOKIE } from "@/lib/sidebar-state";
import { authClient } from "@/services/auth/auth-client";

type CurrentUser = {
  name: string;
  email: string;
  image: string | null;
};

type AppShellProps = {
  children: ReactNode;
  leftDefaultOpen: boolean;
  rightDefaultOpen: boolean;
  currentUser: CurrentUser;
};

type SidebarControls = {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
  toggleSidebar: () => void;
};

function useNavigationFeatures(): NavigationFeatures {
  const pathname = usePathname();
  const [features, setFeatures] = useState<NavigationFeatures>({
    actionsCache: false,
    webhooks: false,
    jiraWebhooks: false,
    github: false,
    gitlab: false,
    gitlabWebhooks: false,
  });

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void controlPlaneRequest<{
        cacheServerSettings: { configured: boolean };
        sourceControlIntegrationState: {
          github: { configured: boolean; webhooksEnabled: boolean };
          gitlab: { configured: boolean; webhooksEnabled: boolean };
        };
        jiraWebhooksEnabled: boolean;
      }>(`query NavigationFeatures {
      cacheServerSettings { configured }
      sourceControlIntegrationState {
        github { configured webhooksEnabled }
        gitlab { configured webhooksEnabled }
      }
      jiraWebhooksEnabled
    }`)
        .then((data) => {
          if (!cancelled) {
            setFeatures({
              actionsCache: data.cacheServerSettings.configured,
              webhooks:
                data.sourceControlIntegrationState.github.webhooksEnabled,
              jiraWebhooks: data.jiraWebhooksEnabled,
              github: data.sourceControlIntegrationState.github.configured,
              gitlab: data.sourceControlIntegrationState.gitlab.configured,
              gitlabWebhooks:
                data.sourceControlIntegrationState.gitlab.webhooksEnabled,
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFeatures({
              actionsCache: false,
              webhooks: false,
              jiraWebhooks: false,
              github: false,
              gitlab: false,
              gitlabWebhooks: false,
            });
          }
        });
    load();
    window.addEventListener("source-control-settings-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("source-control-settings-changed", load);
    };
  }, [pathname]);

  return features;
}

export function AppShell({
  children,
  currentUser,
  leftDefaultOpen,
  rightDefaultOpen,
}: AppShellProps) {
  return (
    <GitHubPipelineStatusProvider>
      <ActionCenterProvider>
        <AppShellFrame
          currentUser={currentUser}
          leftDefaultOpen={leftDefaultOpen}
          rightDefaultOpen={rightDefaultOpen}
        >
          {children}
        </AppShellFrame>
      </ActionCenterProvider>
    </GitHubPipelineStatusProvider>
  );
}

function AppShellFrame({
  children,
  currentUser,
  leftDefaultOpen,
  rightDefaultOpen,
}: AppShellProps) {
  const features = useNavigationFeatures();
  return (
    <SidebarProvider
      className="h-dvh min-h-0 overflow-hidden"
      cookieName={LEFT_SIDEBAR_COOKIE}
      defaultOpen={leftDefaultOpen}
    >
      <NavigationSidebar currentUser={currentUser} features={features} />
      <RightSidebarLayout
        features={features}
        rightDefaultOpen={rightDefaultOpen}
      >
        {children}
      </RightSidebarLayout>
    </SidebarProvider>
  );
}

function RightSidebarLayout({
  children,
  features,
  rightDefaultOpen,
}: {
  children: ReactNode;
  features: NavigationFeatures;
  rightDefaultOpen: boolean;
}) {
  const leftSidebar = useSidebar();

  return (
    <SidebarProvider
      className="h-full min-h-0 min-w-0 flex-1 overflow-hidden"
      cookieName={RIGHT_SIDEBAR_COOKIE}
      defaultOpen={rightDefaultOpen}
      keyboardShortcut={null}
    >
      <ShellContent features={features} leftSidebar={leftSidebar}>
        {children}
      </ShellContent>
    </SidebarProvider>
  );
}

function ShellContent({
  children,
  features,
  leftSidebar,
}: {
  children: ReactNode;
  features: NavigationFeatures;
  leftSidebar: SidebarControls;
}) {
  const rightSidebar = useSidebar();

  return (
    <>
      <div
        className="relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col bg-background"
        data-slot="sidebar-inset"
      >
        <AppHeader
          features={features}
          leftSidebar={leftSidebar}
          rightSidebar={rightSidebar}
        />
        <main className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
          <div
            className="w-full p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6 sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))] [&>*]:!mx-0 [&>*]:!w-full [&>*]:!max-w-none"
            data-slot="page-content"
          >
            {children}
          </div>
        </main>
      </div>
      <NotificationsSidebar />
    </>
  );
}

function AppHeader({
  features,
  leftSidebar,
  rightSidebar,
}: {
  features: NavigationFeatures;
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
      {/* @container so the search trigger sizes off the header's own width,
          which shrinks as the sidebars open, rather than off the viewport. */}
      <div className="@container flex h-14 items-center gap-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1rem,env(safe-area-inset-left))]">
        <SidebarToggle
          expanded={leftOpen}
          hideLabel={t("hideNavigation")}
          onClick={leftSidebar.toggleSidebar}
          showLabel={t("showNavigation")}
          side="left"
        />
        <AppBreadcrumbs />
        <GlobalSearch features={features} />
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

function HeaderBreadcrumbItem({
  breadcrumb,
  className,
}: {
  breadcrumb: AppBreadcrumb;
  className?: string;
}) {
  const labelClassName = breadcrumb.isCurrent
    ? "block min-w-0 truncate"
    : "block max-w-48 truncate lg:max-w-64";

  return (
    <BreadcrumbItem className={`min-w-0 ${className ?? ""}`}>
      {breadcrumb.isCurrent ? (
        <BreadcrumbPage className={labelClassName}>
          {breadcrumb.label}
        </BreadcrumbPage>
      ) : breadcrumb.href ? (
        <BreadcrumbLink asChild className={labelClassName}>
          <Link href={breadcrumb.href}>{breadcrumb.label}</Link>
        </BreadcrumbLink>
      ) : (
        <span className={`${labelClassName} text-muted-foreground`}>
          {breadcrumb.label}
        </span>
      )}
    </BreadcrumbItem>
  );
}

function AppBreadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations("shell");
  const breadcrumbs = buildAppBreadcrumbs(pathname, (key) => t(key));
  const lastIndex = breadcrumbs.length - 1;

  return (
    <Breadcrumb
      aria-label={t("breadcrumbLabel")}
      className="min-w-0 flex-1 overflow-hidden pl-1"
    >
      <BreadcrumbList className="flex-nowrap overflow-hidden">
        {breadcrumbs.length <= 2 ? (
          breadcrumbs.map((breadcrumb, index) => (
            <Fragment key={`${breadcrumb.label}:${index}`}>
              {index > 0 && <BreadcrumbSeparator />}
              <HeaderBreadcrumbItem
                breadcrumb={breadcrumb}
                className={index === lastIndex ? "flex-1" : "shrink-0"}
              />
            </Fragment>
          ))
        ) : (
          <>
            <HeaderBreadcrumbItem
              breadcrumb={breadcrumbs[0]}
              className="shrink-0"
            />
            <BreadcrumbSeparator className="sm:hidden" />
            <BreadcrumbItem className="sm:hidden">
              <BreadcrumbEllipsis />
            </BreadcrumbItem>
            <BreadcrumbSeparator className="sm:hidden" />
            {breadcrumbs.slice(1, lastIndex).map((breadcrumb, index) => (
              <Fragment key={`${breadcrumb.label}:${index + 1}`}>
                <BreadcrumbSeparator className="hidden sm:inline-flex" />
                <HeaderBreadcrumbItem
                  breadcrumb={breadcrumb}
                  className="hidden shrink-0 sm:inline-flex"
                />
              </Fragment>
            ))}
            <BreadcrumbSeparator className="hidden sm:inline-flex" />
            <HeaderBreadcrumbItem
              breadcrumb={breadcrumbs[lastIndex]}
              className="flex-1"
            />
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
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

function UserAccountControl({ user }: { user: CurrentUser }) {
  const t = useTranslations("shell");
  const locale = useLocale();
  const [signingOut, setSigningOut] = useState(false);
  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex items-center gap-2 border-t border-sidebar-border p-2">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold">
        {initials || user.email[0]?.toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{user.name}</p>
        <p className="truncate text-[11px] text-sidebar-foreground/65">
          {user.email}
        </p>
      </div>
      <Button
        aria-label={t("signOut")}
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          void authClient.signOut({
            fetchOptions: {
              onSuccess: () => {
                window.location.assign(`/${locale}/sign-in`);
              },
              onError: () => setSigningOut(false),
            },
          });
        }}
        size="icon-sm"
        title={t("signOut")}
        variant="ghost"
      >
        <LogOut />
      </Button>
    </div>
  );
}

function NavigationSidebar({
  features,
  currentUser,
}: {
  features: NavigationFeatures;
  currentUser: CurrentUser;
}) {
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
        {NAVIGATION_SECTIONS.map((section) => {
          const destinations = APP_DESTINATIONS.filter(
            (destination) =>
              destination.sidebar &&
              destination.section === section &&
              destinationVisible(destination, features),
          );
          if (!destinations.length) return null;
          return (
            <SidebarGroup key={section}>
              <SidebarGroupLabel>{t(section)}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {destinations.map((destination) => {
                    const Icon = destination.icon;
                    return (
                      <SidebarMenuItem key={destination.key}>
                        <SidebarMenuButton
                          asChild
                          isActive={destinationActive(destination, pathname)}
                        >
                          <Link
                            href={destination.href}
                            onClick={() => {
                              if (isMobile) setOpenMobile(false);
                            }}
                          >
                            <Icon />
                            <span>{t(destination.labelKey)}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="gap-0 p-0">
        <UserAccountControl user={currentUser} />
        <SidebarStatusFooter />
      </SidebarFooter>
    </Sidebar>
  );
}
