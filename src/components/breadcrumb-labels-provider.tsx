"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Registration = { path: string; label: string };
type RegisterLabel = (path: string, label: string) => () => void;

const LabelsContext = createContext<Readonly<Record<string, string>>>({});
const RegisterContext = createContext<RegisterLabel | null>(null);

export function BreadcrumbLabelsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [registrations, setRegistrations] = useState(
    () => new Map<symbol, Registration>(),
  );
  const register = useCallback<RegisterLabel>((path, label) => {
    const owner = Symbol();
    setRegistrations((current) => {
      const next = new Map(current);
      next.set(owner, { path, label });
      return next;
    });
    return () => {
      setRegistrations((current) => {
        const next = new Map(current);
        next.delete(owner);
        return next;
      });
    };
  }, []);
  const labels = useMemo(
    () =>
      Object.fromEntries(
        Array.from(registrations.values(), ({ path, label }) => [path, label]),
      ),
    [registrations],
  );

  return (
    <RegisterContext.Provider value={register}>
      <LabelsContext.Provider value={labels}>{children}</LabelsContext.Provider>
    </RegisterContext.Provider>
  );
}

/** Publish the loaded record's title for its route, including on nested pages. */
export function useBreadcrumbLabel(
  segments: readonly (string | number | null | undefined)[],
  label: string | null | undefined,
) {
  const register = useContext(RegisterContext);
  // Use the loaded record's ID, so stale data cannot label a newly opened route.
  const path = segments.every((segment) => segment != null)
    ? `/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`
    : undefined;
  const title = label?.trim();

  useEffect(() => {
    if (!register || !path || !title) return;
    return register(path, title);
  }, [register, path, title]);
}

export function useBreadcrumbLabels() {
  return useContext(LabelsContext);
}
