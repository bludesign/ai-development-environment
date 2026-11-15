"use client";

import { useEffect, useState } from "react";

import {
  clearIntegrationConfigurationCache,
  readIntegrationConfiguration,
  subscribeIntegrationConfiguration,
} from "@/lib/integration-configuration";

import type { IntegrationAvailability } from "./use-worktree-loading";

const QUERY = `query WorktreeIntegrationAvailability {
  sourceControlIntegrationState { github { configured } gitlab { configured } }
  jiraSettings { tokenConfigured }
}`;
/** One cached answer covers three providers, so any provider change clears it. */
const CACHE_KEY = "worktreeEnrichment";
const ASSUME_CONNECTED: IntegrationAvailability = {
  github: true,
  gitlab: true,
  jira: true,
};

type Response = {
  sourceControlIntegrationState: {
    github: { configured: boolean };
    gitlab: { configured: boolean };
  };
  jiraSettings: { tokenConfigured: boolean };
};

/**
 * Which integrations worktree metadata can come from. A separate read from the
 * worktree list, so a credential store that cannot answer never costs the
 * list; a failed read falls back to asking every integration as before.
 */
export function useIntegrationAvailability():
  IntegrationAvailability | "pending" {
  const [value, setValue] = useState<IntegrationAvailability | "pending">(
    "pending",
  );

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      void readIntegrationConfiguration<Response>(CACHE_KEY, QUERY, {
        signal: controller.signal,
      })
        .then((data) => {
          if (controller.signal.aborted) return;
          setValue({
            github: data.sourceControlIntegrationState.github.configured,
            gitlab: data.sourceControlIntegrationState.gitlab.configured,
            jira: data.jiraSettings.tokenConfigured,
          });
        })
        .catch(() => {
          if (!controller.signal.aborted) setValue(ASSUME_CONNECTED);
        });
    };
    load();
    const off = subscribeIntegrationConfiguration(null, () => {
      clearIntegrationConfigurationCache(CACHE_KEY);
      load();
    });
    return () => {
      controller.abort();
      off();
    };
  }, []);

  return value;
}
