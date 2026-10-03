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
import type { BreadcrumbLabels } from "@/lib/breadcrumbs";

type Registration = { path: string; label: string | null };
type RegisterLabel = (path: string, label: string | null) => () => void;
type RouteSegments = readonly (string | number | null | undefined)[];

const LabelsContext = createContext<BreadcrumbLabels>({});
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
        Array.from(registrations.values())
          // A loaded title takes precedence over a missing-record fallback
          // from another mounted publisher for the same route.
          .sort((a, b) => Number(a.label !== null) - Number(b.label !== null))
          .map(({ path, label }) => [path, label]),
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
  segments: RouteSegments,
  label: string | null | undefined,
) {
  const register = useContext(RegisterContext);
  // Use the loaded record's ID, so stale data cannot label a newly opened route.
  const path = routePath(segments);
  const title = label?.trim();

  useEffect(() => {
    if (!register || !path || !title) return;
    return register(path, title);
  }, [register, path, title]);
}

/** End the placeholder when fetching fails or the requested record is missing. */
export function useBreadcrumbFallback(
  segments: RouteSegments,
  unavailable: boolean,
) {
  const register = useContext(RegisterContext);
  const path = routePath(segments);
  useEffect(() => {
    if (!register || !path || !unavailable) return;
    return register(path, null);
  }, [register, path, unavailable]);
}

function routePath(segments: RouteSegments) {
  return segments.every((segment) => segment != null)
    ? `/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`
    : undefined;
}

export function useBreadcrumbLabels() {
  return useContext(LabelsContext);
}
