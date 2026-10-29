import "server-only";

import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";

import { GitHubReviewerProvider } from "./github-provider";
import { GitLabReviewerProvider } from "./gitlab-provider";
import type {
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
  ) {
    return /^github\.com\//i.test(repository.canonicalOrigin)
      ? this.github.discover(repository, ref, request)
      : this.gitlab.discover(repository, ref, request, refresh);
  }

  assign(
    repository: ReviewerRepository,
    request: ReviewerRequestLocator,
    people: ReviewerPerson[],
  ) {
    return /^github\.com\//i.test(repository.canonicalOrigin)
      ? this.github.assign(repository, request, people)
      : this.gitlab.assign(repository, request, people);
  }
}
