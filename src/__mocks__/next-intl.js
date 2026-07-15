// Mock for next-intl. This file is loaded directly by Vitest aliases, so it
// intentionally remains CommonJS and does not reference vi.
/* eslint-disable @typescript-eslint/no-require-imports */
const React = require("react");

const mockTranslations = {
  metadata: {
    title: "AI Development Environment",
    description: "An AI-focused development environment.",
  },
  shell: {
    productName: "AI Development Environment",
    welcome: "Welcome",
    dashboard: "Dashboard",
    navigation: "Navigation",
    navigationDescription: "Primary navigation for AI Development Environment.",
    notifications: "Notifications",
    notificationsDescription: "Notification updates and alerts.",
    showNavigation: "Show navigation",
    hideNavigation: "Hide navigation",
    closeNavigation: "Close navigation",
    showNotifications: "Show notifications",
    hideNotifications: "Hide notifications",
    closeNotifications: "Close notifications",
    agents: "Agents",
  },
  agents: {
    title: "Agents",
    description:
      "Manage enrolled Macs and durable jobs from one control plane.",
    refresh: "Refresh",
    enroll: "Enroll agent",
    enrollmentTitle: "One-time enrollment command",
    enrollmentDescription:
      "Run this on the Mac after installing mac-control-agent. The Mac connects outbound; it does not open a listening port.",
    copy: "Copy command",
    expires: "Token expires {date}",
    loading: "Loading agents…",
    emptyTitle: "No agents enrolled",
    emptyDescription: "Create an enrollment command to pair your first Mac.",
    version: "Version",
    platform: "Platform",
    lastSeen: "Last seen",
    never: "Never",
  },
};

const useTranslations = (namespace) => {
  return (key, values) => {
    const namespaceParts = namespace ? namespace.split(".") : [];
    let namespaceTranslations = mockTranslations;

    for (const part of namespaceParts) {
      namespaceTranslations = Object.prototype.hasOwnProperty.call(
        namespaceTranslations,
        part,
      )
        ? namespaceTranslations[part]
        : {};
    }

    const keyParts = key.split(".");
    let translation = namespaceTranslations;

    for (const keyPart of keyParts) {
      translation =
        translation &&
        Object.prototype.hasOwnProperty.call(translation, keyPart)
          ? translation[keyPart]
          : null;
    }

    if (!translation) {
      translation = namespace ? `${namespace}.${key}` : key;
    }

    if (values && typeof translation === "string") {
      for (const [valueKey, value] of Object.entries(values)) {
        translation = translation.replaceAll(`{${valueKey}}`, String(value));
      }
    }

    return translation;
  };
};

const NextIntlClientProvider = ({ children }) => children;
const useLocale = () => "en";
const hasLocale = (supportedLocales, locale) =>
  typeof locale === "string" && supportedLocales.includes(locale);
const mockPush = () => {};
const mockReplace = () => {};
const useRouter = () => ({
  push: mockPush,
  replace: mockReplace,
  prefetch: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
});
const usePathname = () => "/";
const Link = ({ children, href, ...props }) =>
  React.createElement("a", { href, ...props }, children);
const defineRouting = (config) => config;
const createNavigation = () => ({
  Link,
  redirect: () => {},
  useRouter,
  usePathname,
  getPathname: () => "/",
});

module.exports = {
  mockTranslations,
  useTranslations,
  NextIntlClientProvider,
  useLocale,
  hasLocale,
  useRouter,
  usePathname,
  Link,
  defineRouting,
  createNavigation,
  mockPush,
  mockReplace,
};
