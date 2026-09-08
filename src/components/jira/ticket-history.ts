"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraActivityPage, JiraChange } from "@/services/jira/types";

import { JIRA_CACHE_FIELDS, JIRA_PERSON_FIELDS } from "./ticket-graphql";

const PAGE_SIZE = 50;

export type JiraTicketHistoryState = {
  changes: JiraChange[];
  error: string | null;
  load: () => Promise<void>;
  loading: boolean;
  reset: () => void;
  total: number | null;
};

export function useJiraTicketHistory(issueKey: string): JiraTicketHistoryState {
  const [changes, setChanges] = useState<JiraChange[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        jiraTicketChanges: JiraActivityPage<JiraChange>;
      }>(
        `query JiraTicketChanges($issueKey: ID!, $limit: Int!, $offset: Int!, $snapshotTotal: Int) {
          jiraTicketChanges(issueKey: $issueKey, limit: $limit, offset: $offset, snapshotTotal: $snapshotTotal) {
            items {
              id author { ${JIRA_PERSON_FIELDS} } createdAt
              items { field fieldId from to }
            }
            total limit offset cache { ${JIRA_CACHE_FIELDS} }
          }
        }`,
        {
          issueKey,
          limit: PAGE_SIZE,
          offset: changes.length,
          snapshotTotal: total,
        },
        { signal: controller.signal },
      );
      if (generation !== generationRef.current || controller.signal.aborted)
        return;
      setChanges((current) => [...current, ...data.jiraTicketChanges.items]);
      setTotal(data.jiraTicketChanges.total);
    } catch (value) {
      if (generation !== generationRef.current || controller.signal.aborted)
        return;
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (generation === generationRef.current && !controller.signal.aborted) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [changes.length, issueKey, total]);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    generationRef.current += 1;
    loadingRef.current = false;
    setChanges([]);
    setTotal(null);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(reset, 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [issueKey, reset]);
  return { changes, error, load, loading, reset, total };
}
