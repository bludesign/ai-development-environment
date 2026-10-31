export const baseBranchUpdateOptions = {
  destinationBaseBranch: "main",
  selectedWorktreeIds: [],
  results: [],
  worktrees: [
    {
      id: "dependent-mac",
      branch: "feature/AIDE-169-search-filters",
      folder: "/Users/acme/Repositories/app-search-filters",
      agentName: "Mac Studio",
      baseBranch: "feature/quick-search",
      canUpdate: true,
    },
    {
      id: "dependent-mini",
      branch: "feature/AIDE-170-search-tests",
      folder: "/Users/acme/Repositories/app-search-tests",
      agentName: "Mac mini",
      baseBranch: "feature/quick-search",
      canUpdate: true,
    },
  ],
};
