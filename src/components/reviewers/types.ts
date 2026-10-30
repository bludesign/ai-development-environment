export type CodeReviewerPerson = {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  url: string | null;
};

export type CodeReviewerPool = {
  key: string;
  name: string;
  kind: string;
  candidates: CodeReviewerPerson[];
  selectedReviewerIds: string[];
  unavailableReviewerIds: string[];
};

export type RepositoryCodeReviewers = {
  repositoryId: string;
  provider: string;
  ref: string;
  defaultRef: string;
  refs: string[];
  pools: CodeReviewerPool[];
  issues: string[];
  discoveryComplete: boolean;
};

export type ReviewerAssignmentRequirement = {
  id: string;
  name: string;
  poolKeys: string[];
  requiredApprovals: number;
  eligibleReviewerIds: string[];
  candidateReviewerIds: string[];
  approvedReviewerIds: string[];
  requestedReviewerIds: string[];
};

export type WorktreeReviewerAssignment = {
  worktreeId: string;
  requestId: string;
  requestUrl: string;
  provider: string;
  requestOpen: boolean;
  authorId: string;
  reviewers: CodeReviewerPerson[];
  requirements: ReviewerAssignmentRequirement[];
  currentReviewerIds: string[];
  approvedReviewerIds: string[];
  selectedReviewerIds: string[];
  issues: string[];
  discoveryComplete: boolean;
};

export const CODE_REVIEWER_PERSON_FIELDS = "id username name avatarUrl url";

export type WorktreeReviewRequirement = {
  id: string;
  name: string;
  isRequired: boolean;
  patterns: string[];
  requiredApprovals: number;
  groups: Array<{ key: string; name: string; kind: string }>;
  eligibleReviewerIds: string[];
  approvedReviewerIds: string[];
  requestedReviewerIds: string[];
};

export type WorktreeReviewStatus = {
  worktreeId: string;
  requestId: string;
  requestUrl: string;
  provider: string;
  requestOpen: boolean;
  reviewers: CodeReviewerPerson[];
  currentReviewerIds: string[];
  approvedReviewerIds: string[];
  requirements: WorktreeReviewRequirement[];
  issues: string[];
  discoveryComplete: boolean;
};

export const WORKTREE_REVIEW_STATUS_FIELDS = `
  worktreeId requestId requestUrl provider requestOpen
  currentReviewerIds approvedReviewerIds issues discoveryComplete
  reviewers { ${CODE_REVIEWER_PERSON_FIELDS} }
  requirements {
    id name isRequired patterns requiredApprovals
    groups { key name kind }
    eligibleReviewerIds approvedReviewerIds requestedReviewerIds
  }
`;
export const REPOSITORY_CODE_REVIEWERS_FIELDS = `
  repositoryId provider ref defaultRef refs discoveryComplete issues
  pools {
    key name kind selectedReviewerIds unavailableReviewerIds
    candidates { ${CODE_REVIEWER_PERSON_FIELDS} }
  }
`;
export const WORKTREE_REVIEWER_ASSIGNMENT_FIELDS = `
  worktreeId requestId requestUrl provider requestOpen authorId
  currentReviewerIds approvedReviewerIds selectedReviewerIds issues discoveryComplete
  reviewers { ${CODE_REVIEWER_PERSON_FIELDS} }
  requirements {
    id name poolKeys requiredApprovals eligibleReviewerIds candidateReviewerIds
    approvedReviewerIds requestedReviewerIds
  }
`;

export function toggleReviewer(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}
