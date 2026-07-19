"use client";

import { ChevronDown, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { BuildDestination } from "./types";

export function RunBuildControls({
  buildId,
  destinationType,
  preferredDestination,
  onCompleted,
  onError,
  size = "default",
}: {
  buildId: string;
  destinationType: BuildDestination["type"];
  preferredDestination?: BuildDestination | null;
  onCompleted?: () => void | Promise<void>;
  onError: (error: string | null) => void;
  size?: "sm" | "default";
}) {
  const t = useTranslations("builds");
  const preferred = preferredDestination?.generic
    ? null
    : (preferredDestination ?? null);
  const [destinations, setDestinations] = useState<BuildDestination[]>(
    preferred ? [preferred] : [],
  );
  const [selectedDestinations, setSelectedDestinations] = useState<Set<string>>(
    preferred ? new Set([preferred.id]) : new Set(),
  );
  const [destinationsLoaded, setDestinationsLoaded] = useState(false);
  const [loadingDestinations, setLoadingDestinations] = useState(false);
  const [running, setRunning] = useState(false);

  const selectedNames = useMemo(
    () =>
      destinations
        .filter((destination) => selectedDestinations.has(destination.id))
        .map((destination) => destination.name),
    [destinations, selectedDestinations],
  );

  const loadDestinations = async () => {
    setLoadingDestinations(true);
    onError(null);
    try {
      const data = await controlPlaneRequest<{
        inspectBuildRunDestinations: BuildDestination[];
      }>(
        `mutation BuildRunDestinations($buildId: ID!, $requestId: ID!) {
          inspectBuildRunDestinations(buildId: $buildId, requestId: $requestId)
        }`,
        { buildId, requestId: createClientId() },
      );
      const compatible = data.inspectBuildRunDestinations.filter(
        (destination) =>
          destination.type === destinationType && !destination.generic,
      );
      setDestinations(compatible);
      setSelectedDestinations((current) => {
        const availableIds = new Set(
          compatible.map((destination) => destination.id),
        );
        return new Set([...current].filter((id) => availableIds.has(id)));
      });
      setDestinationsLoaded(true);
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingDestinations(false);
    }
  };

  const run = async () => {
    setRunning(true);
    onError(null);
    try {
      await controlPlaneRequest(
        `mutation RunCompletedBuild($input: RunBuildInput!) {
          runBuild(input: $input) { id status }
        }`,
        {
          input: {
            buildId,
            destinations: destinations.filter((destination) =>
              selectedDestinations.has(destination.id),
            ),
            requestId: createClientId(),
          },
        },
      );
      setSelectedDestinations(new Set());
      await onCompleted?.();
    } catch (value) {
      onError(value instanceof Error ? value.message : String(value));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="flex items-center justify-end gap-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu
        onOpenChange={(open) => {
          if (open && !destinationsLoaded) void loadDestinations();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            disabled={loadingDestinations}
            size={size}
            type="button"
            variant="outline"
          >
            {loadingDestinations ? <Spinner /> : <Play />}
            {selectedNames.length
              ? t("selectedDevices", { count: selectedNames.length })
              : t("selectRunDevices")}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {destinations.map((destination) => (
            <DropdownMenuCheckboxItem
              checked={selectedDestinations.has(destination.id)}
              key={destination.id}
              onCheckedChange={(checked) =>
                setSelectedDestinations((current) => {
                  const next = new Set(current);
                  if (checked) next.add(destination.id);
                  else next.delete(destination.id);
                  return next;
                })
              }
            >
              {destination.name}
              {destination.osVersion ? ` · ${destination.osVersion}` : ""}
            </DropdownMenuCheckboxItem>
          ))}
          {destinationsLoaded && !destinations.length && (
            <p className="p-2 text-xs text-muted-foreground">
              {t("noCompatibleDevices")}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        disabled={running || selectedDestinations.size === 0}
        onClick={() => void run()}
        size={size}
        type="button"
      >
        {running ? <Spinner /> : <Play />} {t("run")}
      </Button>
    </div>
  );
}
