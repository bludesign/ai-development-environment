export const JIRA_RICH_TEXT_FIELDS = "format raw rawText markdown wikiMarkup";
export const JIRA_PERSON_FIELDS = "accountId displayName avatarUrl";
export const JIRA_CACHE_FIELDS = "source stale fetchedAt";
export const JIRA_LINK_FIELDS = "relationship key summary status";
export const JIRA_SUMMARY_FIELDS =
  "id key summary statusId status statusCategory issueType priority assignee assigneeAccountId assigneeAvatarUrl projectKey updatedAt";

export const JIRA_TICKET_DETAIL_FIELDS = `${JIRA_SUMMARY_FIELDS}
  jiraUrl description
  descriptionContent { ${JIRA_RICH_TEXT_FIELDS} }
  reporter { ${JIRA_PERSON_FIELDS} }
  creator { ${JIRA_PERSON_FIELDS} }
  labels components { id name } fixVersions { id name }
  affectedVersions { id name } sprintNames
  parent { ${JIRA_LINK_FIELDS} }
  subtasks { ${JIRA_LINK_FIELDS} }
  issueLinks { ${JIRA_LINK_FIELDS} }
  attachments {
    id filename contentUrl mimeType size
    author { ${JIRA_PERSON_FIELDS} }
    createdAt
  }
  comments {
    id author { ${JIRA_PERSON_FIELDS} } body
    content { ${JIRA_RICH_TEXT_FIELDS} }
    createdAt updatedAt
  }
  createdAt dueAt resolvedAt timeTracking
  allFields {
    id name schemaType custom value
    content { ${JIRA_RICH_TEXT_FIELDS} }
  }
  cache { ${JIRA_CACHE_FIELDS} }
  commentsCache { ${JIRA_CACHE_FIELDS} }`;
