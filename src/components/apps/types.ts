export type AppRepository = {
  id: string;
  canonicalOrigin: string;
  displayOrigin: string;
  name: string;
  description: string;
  codebases: Array<{
    id: string;
    folder: string;
    branch: string | null;
    availability: string;
    agent: {
      id: string;
      name: string;
      hostname: string;
      connectionStatus: string;
    };
  }>;
};

export type AppCounts = {
  repositories: number;
  codebases: number;
  worktrees: number;
  dirtyWorktrees: number;
  plans: number;
  sessions: number;
  builds: number;
};

export type ManagedApp = {
  id: string;
  name: string;
  description: string;
  agentIds: string[];
  repositories: AppRepository[];
  counts: AppCounts;
  createdAt: string;
  updatedAt: string;
};

export const APP_REPOSITORY_FIELDS = `
  id canonicalOrigin displayOrigin name description
  codebases {
    id folder branch availability
    agent { id name hostname connectionStatus }
  }
`;

export const APP_FIELDS = `
  id name description agentIds createdAt updatedAt
  counts { repositories codebases worktrees dirtyWorktrees plans sessions builds }
  repositories { ${APP_REPOSITORY_FIELDS} }
`;
