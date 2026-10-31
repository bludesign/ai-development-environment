import "server-only";

import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";

import { GitHubReviewerProvider } from "./github-provider";
import { GitLabReviewerProvider } from "./gitlab-provider";
import type {
  ReviewerDiscoveryOptions,
  ReviewerPerson,
  ReviewerProviderAdapter,
  ReviewerRepository,
  ReviewerRequestLocator,
} from "./types";

export class ReviewerProviders implements ReviewerProviderAdapter {
  private readonly github: GitHubReviewerProvider;
  private readonly gitlab: GitLabReviewerProvider;

  constructor(github: GitHubService, gitlab: GitLabService) {
    this.github = new GitHubReviewerProvider(github);
    this.gitlab = new GitLabReviewerProvider(gitlab);
  }

  discover(
    repository: ReviewerRepository,
    ref?: string,
    request?: ReviewerRequestLocator,
    refresh = false,
    options: ReviewerDiscoveryOptions = {},
  ) {
    return /^github\.com\//i.test(repository.canonicalOrigin)
      ? this.github.discover(repository, ref, request, refresh, options)
      : this.gitlab.discover(repository, ref, request, refresh, options);
  }

  resolvePeople(repository: ReviewerRepository, ids: string[]) {
    return /^github\.com\//i.test(repository.canonicalOrigin)
      ? this.github.resolvePeople(ids)
      : this.gitlab.resolvePeople(ids);
  }

  assign(
    repository: ReviewerRepository,
    request: ReviewerRequestLocator,
    people: ReviewerPerson[],
    removePeople: ReviewerPerson[] = [],
  ) {
    return /^github\.com\//i.test(repository.canonicalOrigin)
      ? this.github.assign(repository, request, people, removePeople)
      : this.gitlab.assign(repository, request, people, removePeople);
  }
}
