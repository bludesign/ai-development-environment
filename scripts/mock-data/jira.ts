import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { daysAgo, hoursAgo, minutesAgo } from "./time";

const ISSUE_KEY = ids.jira.issueKey;

function adfParagraph(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

export async function seedJira(prisma: PrismaClient): Promise<void> {
  await prisma.jiraProject.create({
    data: {
      id: ids.jira.projectId,
      jiraId: "10042",
      key: ids.jira.projectKey,
      name: "Acme Platform",
      avatarUrl: "https://acme.atlassian.net/avatar/acme.png",
      position: 0,
      ticketAssignmentFilter: "ALL",
      hideCompletedTickets: false,
      doneStatusId: "10003",
      completedStatusIdsJson: JSON.stringify(["10003"]),
      sources: {
        create: [
          {
            id: ids.jira.sourceId,
            name: "Active Sprint",
            kind: "JQL",
            value: "project = ACME AND sprint in openSprints() ORDER BY rank",
            position: 0,
          },
        ],
      },
    },
  });

  const summaryFields = {
    summary: "Add quick search to the global navigation bar",
    status: {
      name: "In Progress",
      statusCategory: { key: "indeterminate", name: "In Progress" },
    },
    priority: { name: "High" },
    issuetype: { name: "Story" },
    assignee: { displayName: "Jane Doe" },
    reporter: { displayName: "John Smith" },
    labels: ["frontend", "search"],
    updated: hoursAgo(2).toISOString(),
    created: daysAgo(6).toISOString(),
  };

  await prisma.jiraCachedTicket.create({
    data: {
      issueKey: ISSUE_KEY,
      projectKey: ids.jira.projectKey,
      summaryJson: JSON.stringify({ key: ISSUE_KEY, fields: summaryFields }),
      summaryFetchedAt: minutesAgo(4),
      detailJson: JSON.stringify({
        key: ISSUE_KEY,
        fields: {
          ...summaryFields,
          description: adfParagraph(
            "As a user, I want a quick search in the navigation bar so I can jump to any page or record with the keyboard.",
          ),
        },
      }),
      detailFetchedAt: minutesAgo(4),
      commentsJson: JSON.stringify({
        total: 2,
        comments: [
          {
            id: "comment-1",
            author: { displayName: "John Smith" },
            body: adfParagraph("Let's make sure ⌘K opens the palette."),
            created: daysAgo(3).toISOString(),
          },
          {
            id: "comment-2",
            author: { displayName: "Jane Doe" },
            body: adfParagraph("Done — added keyboard navigation and tests."),
            created: hoursAgo(3).toISOString(),
          },
        ],
      }),
      commentsFetchedAt: minutesAgo(4),
    },
  });

  await prisma.jiraCacheEntry.create({
    data: {
      id: "jira-cache-entry-sprint",
      cacheKey: "jira:acme:active-sprint",
      operation: "searchIssues",
      paramsJson: JSON.stringify({
        jql: "project = ACME AND sprint in openSprints()",
      }),
      responseJson: JSON.stringify({
        total: 1,
        issues: [{ key: ISSUE_KEY, fields: summaryFields }],
      }),
      fetchedAt: minutesAgo(4),
      sourceId: ids.jira.sourceId,
      issues: {
        create: [{ issueKey: ISSUE_KEY }],
      },
    },
  });

  await prisma.jiraApiCallLog.createMany({
    data: [
      {
        id: "jira-api-log-1",
        operation: "searchIssues",
        requestSummary: "project = ACME AND sprint in openSprints()",
        source: "LIVE",
        durationMs: 412,
        statusCode: 200,
        itemCount: 1,
        sourceId: ids.jira.sourceId,
        createdAt: minutesAgo(4),
      },
      {
        id: "jira-api-log-2",
        operation: "getIssue",
        requestSummary: ISSUE_KEY,
        source: "CACHE",
        durationMs: 2,
        servedStale: false,
        createdAt: minutesAgo(2),
      },
    ],
  });
}
