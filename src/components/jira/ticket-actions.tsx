"use client";

import { ChevronsUpDown, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  JiraPerson,
  JiraTicketDetail,
  JiraTransition,
} from "@/services/jira/types";

import {
  JIRA_PERSON_FIELDS,
  JIRA_TICKET_DETAIL_FIELDS,
} from "./ticket-graphql";

export function JiraTicketActions({
  onTicketChange,
  ticket,
}: {
  onTicketChange: (ticket: JiraTicketDetail) => void;
  ticket: JiraTicketDetail;
}) {
  const t = useTranslations("jiraTickets");
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [assignees, setAssignees] = useState<JiraPerson[]>([]);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeQuery, setAssigneeQuery] = useState("");
  const [loadingAssignees, setLoadingAssignees] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadTransitions = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        jiraTicketTransitions: JiraTransition[];
      }>(
        `query JiraTicketTransitions($issueKey: ID!) {
          jiraTicketTransitions(issueKey: $issueKey) {
            id name toStatusId toStatus toStatusCategory hasScreen requiredFields
          }
        }`,
        { issueKey: ticket.key },
      );
      setTransitions(data.jiraTicketTransitions ?? []);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [ticket.key]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadTransitions(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadTransitions]);

  useEffect(() => {
    if (!assigneeOpen) return;
    const sequence = ++requestSequence.current;
    const timeout = window.setTimeout(async () => {
      setLoadingAssignees(true);
      try {
        const data = await controlPlaneRequest<{
          jiraAssignableUsers: JiraPerson[];
        }>(
          `query JiraAssignableUsers($issueKey: ID!, $query: String) {
            jiraAssignableUsers(issueKey: $issueKey, query: $query) {
              ${JIRA_PERSON_FIELDS}
            }
          }`,
          { issueKey: ticket.key, query: assigneeQuery },
        );
        if (requestSequence.current === sequence) {
          setAssignees(data.jiraAssignableUsers ?? []);
        }
      } catch (value) {
        if (requestSequence.current === sequence) {
          setError(value instanceof Error ? value.message : String(value));
        }
      } finally {
        if (requestSequence.current === sequence) setLoadingAssignees(false);
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [assigneeOpen, assigneeQuery, ticket.key]);

  const assign = async (accountId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        assignJiraTicket: JiraTicketDetail;
      }>(
        `mutation AssignJiraTicket($issueKey: ID!, $accountId: ID) {
          assignJiraTicket(issueKey: $issueKey, accountId: $accountId) {
            ${JIRA_TICKET_DETAIL_FIELDS}
          }
        }`,
        { issueKey: ticket.key, accountId },
      );
      onTicketChange(data.assignJiraTicket);
      setAssigneeOpen(false);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const transition = async (transitionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        transitionJiraTicket: JiraTicketDetail;
      }>(
        `mutation TransitionJiraTicket($issueKey: ID!, $transitionId: ID!) {
          transitionJiraTicket(issueKey: $issueKey, transitionId: $transitionId) {
            ${JIRA_TICKET_DETAIL_FIELDS}
          }
        }`,
        { issueKey: ticket.key, transitionId },
      );
      onTicketChange(data.transitionJiraTicket);
      await loadTransitions();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">{t("assignee")}</p>
          <Popover onOpenChange={setAssigneeOpen} open={assigneeOpen}>
            <PopoverTrigger asChild>
              <Button
                aria-label={t("changeAssignee")}
                className="w-full justify-between font-normal"
                disabled={busy}
                role="combobox"
                variant="outline"
              >
                <span className="truncate">
                  {ticket.assignee ?? t("unassigned")}
                </span>
                <ChevronsUpDown className="opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-2 p-2">
              <Input
                aria-label={t("searchAssignees")}
                autoFocus
                onChange={(event) => setAssigneeQuery(event.target.value)}
                placeholder={t("searchAssignees")}
                value={assigneeQuery}
              />
              <div className="max-h-64 space-y-1 overflow-y-auto">
                <Button
                  className="w-full justify-start font-normal"
                  onClick={() => void assign(null)}
                  size="sm"
                  variant="ghost"
                >
                  {t("unassigned")}
                </Button>
                {loadingAssignees ? (
                  <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                    <Loader2 className="animate-spin" /> {t("loadingAssignees")}
                  </p>
                ) : assignees.length === 0 ? (
                  <p className="p-2 text-xs text-muted-foreground">
                    {t("noAssignees")}
                  </p>
                ) : (
                  assignees.map((person) => (
                    <Button
                      className="w-full justify-start font-normal"
                      key={person.accountId ?? person.displayName}
                      onClick={() => void assign(person.accountId)}
                      size="sm"
                      variant="ghost"
                    >
                      {person.displayName}
                    </Button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">{t("status")}</p>
          <Select disabled={busy} onValueChange={(id) => void transition(id)}>
            <SelectTrigger aria-label={t("changeStatus")} className="w-full">
              <SelectValue placeholder={ticket.status} />
            </SelectTrigger>
            <SelectContent>
              {transitions.map((item) => (
                <SelectItem
                  disabled={item.requiredFields.length > 0}
                  key={item.id}
                  value={item.id}
                >
                  {item.toStatus}
                  {item.requiredFields.length > 0
                    ? ` · ${t("requiresJira")}`
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
