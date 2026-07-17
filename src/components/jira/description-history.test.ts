import { describe, expect, test } from "vitest";

import type { JiraChange, JiraTicketDetail } from "@/services/jira/types";

import { buildDescriptionVersions } from "./description-history";

describe("buildDescriptionVersions", () => {
  test("reconstructs description snapshots from newest-first activity", () => {
    const ticket = {
      description: null,
      descriptionContent: {
        format: "ADF",
        raw: { type: "doc", version: 1, content: [] },
        rawText: '{"type":"doc","version":1}',
        markdown:
          '<!-- adf:paragraph attrs=\'{"localId":"current"}\' -->\n\nCurrent text',
        wikiMarkup: "Current text",
      },
      updatedAt: "2026-07-17T12:00:00.000Z",
    } as JiraTicketDetail;
    const changes: JiraChange[] = [
      {
        id: "change-2",
        author: {
          accountId: "ada",
          displayName: "Ada",
          avatarUrl: null,
        },
        createdAt: "2026-07-17T11:00:00.000Z",
        items: [
          {
            field: "Description",
            fieldId: "description",
            from: "Earlier text",
            to: "Current text",
          },
        ],
      },
      {
        id: "change-1",
        author: null,
        createdAt: "2026-07-16T11:00:00.000Z",
        items: [
          {
            field: "description",
            fieldId: null,
            from: "Original text",
            to: "Earlier text",
          },
        ],
      },
    ];

    const versions = buildDescriptionVersions(ticket, changes);

    expect(versions.map((version) => version.value)).toEqual([
      "Current text",
      "Earlier text",
      "Original text",
    ]);
    expect(versions.map((version) => version.kind)).toEqual([
      "CURRENT",
      "BEFORE",
      "BEFORE",
    ]);
    expect(versions[1].author?.displayName).toBe("Ada");
  });
});
