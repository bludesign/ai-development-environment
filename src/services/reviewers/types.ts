export type ReviewerPerson = {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  url: string | null;
};

export type ReviewerRepository = { id: string; canonicalOrigin: string };
export type ReviewerRequestLocator = {
  id: string;
  number: number;
  projectId?: string;
};

export type ReviewerPoolDiscovery = {
  key: string;
  name: string;
  kind: "GENERAL" | "CODEOWNERS" | "APPROVAL_RULE";
  candidates: ReviewerPerson[];
};

export type ReviewerRequirementDiscovery = {
  id: string;
  name: string;
  poolKeys: string[];
  eligibleReviewerIds: string[];
  requiredApprovals: number;
  approvedReviewerIds: string[];
};

export type ReviewerDiscovery = {
  provider: "GITHUB" | "GITLAB";
  repositoryIdentity: string;
  ref: string;
  defaultRef: string;
  refs: string[];
  pools: ReviewerPoolDiscovery[];
  requirements: ReviewerRequirementDiscovery[];
  issues: string[];
  discoveryComplete: boolean;
  request?: {
    id: string;
    number: number;
    url: string;
    open: boolean;
    authorId: string;
    baseRef: string;
    headSha: string;
    currentReviewers: ReviewerPerson[];
    approvedReviewers: ReviewerPerson[];
  };
};

export interface ReviewerProviderAdapter {
  discover(
    repository: ReviewerRepository,
    ref?: string,
    request?: ReviewerRequestLocator,
    refresh?: boolean,
  ): Promise<ReviewerDiscovery>;
  assign(
    repository: ReviewerRepository,
    request: ReviewerRequestLocator,
    people: ReviewerPerson[],
  ): Promise<void>;
}

export type SaveReviewerPoolsInput = {
  repositoryId: string;
  ref?: string | null;
  pools: Array<{ key: string; reviewerIds: string[] }>;
};
