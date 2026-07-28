"use client";

import { useEffect, useRef } from "react";

import {
  controlPlaneSubscriptions,
  onControlPlaneConnected,
} from "@/lib/control-plane-client";
import type { JiraTicketChange } from "@/services/jira/types";

/**
 * Subscribes to Jira ticket changes observed through the webhook.
 *
 * `onChange` is called with each change, and `onReconnect` after the socket
 * comes back — changes that arrived during a drop are never replayed, so the
 * caller has to reconcile by refetching.
 *
 * Both callbacks are held in refs so callers can pass inline closures without
 * tearing down and re-establishing the subscription on every render.
 */
export function useJiraTicketChanges(
  onChange: (change: JiraTicketChange) => void,
  onReconnect?: () => void,
): void {
  const changeRef = useRef(onChange);
  const reconnectRef = useRef(onReconnect);

  useEffect(() => {
    changeRef.current = onChange;
    reconnectRef.current = onReconnect;
  }, [onChange, onReconnect]);

  useEffect(() => {
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      jiraTicketChanged: JiraTicketChange;
    }>(
      {
        query: `subscription JiraTicketChanged {
          jiraTicketChanged { issueKey projectKey event }
        }`,
      },
      {
        next: (result) => {
          const change = result.data?.jiraTicketChanged;
          if (change) changeRef.current(change);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const reconnect = onControlPlaneConnected(() => reconnectRef.current?.());
    return () => {
      unsubscribe();
      reconnect();
    };
  }, []);
}
