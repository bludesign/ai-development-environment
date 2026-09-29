import { describe, expect, test } from "vitest";

import {
  aggregateGitLabPipelineStatus,
  canCancelGitLabPipeline,
  canRetryGitLabJob,
  canRetryGitLabPipeline,
  gitLabDuration,
  gitLabPipelineStatusClass,
  gitLabPipelineStatuses,
  isActiveGitLabPipeline,
} from "./pipeline-format";

describe("GitLab pipeline presentation", () => {
  test("all supported states have a semantic style and terminal states stop polling", () => {
    for (const status of gitLabPipelineStatuses)
      expect(gitLabPipelineStatusClass(status)).toMatch(/border-/);
    expect(isActiveGitLabPipeline("WAITING_FOR_CALLBACK")).toBe(true);
    expect(isActiveGitLabPipeline("CANCELING")).toBe(true);
    expect(canCancelGitLabPipeline("CANCELING")).toBe(false);
    expect(isActiveGitLabPipeline("SUCCESS")).toBe(false);
    expect(isActiveGitLabPipeline("MANUAL")).toBe(false);
    expect(canRetryGitLabPipeline("SUCCESS")).toBe(false);
    expect(canRetryGitLabJob("SUCCESS")).toBe(true);
    expect(canRetryGitLabPipeline("FAILED")).toBe(true);
  });
  test("a passing pipeline does not hide another pipeline waiting for resources", () => {
    expect(
      aggregateGitLabPipelineStatus(["SUCCESS", "WAITING_FOR_RESOURCE"]),
    ).toBe("WAITING_FOR_RESOURCE");
    expect(aggregateGitLabPipelineStatus(["SUCCESS", "MANUAL"])).toBe("MANUAL");
    expect(aggregateGitLabPipelineStatus([])).toBe("UNKNOWN");
  });
  test("formats real elapsed time for active jobs and preserves completed duration", () => {
    expect(
      gitLabDuration(
        { status: "RUNNING", startedAt: "2026-09-20T12:00:00Z", duration: 3 },
        Date.parse("2026-09-20T12:01:05Z"),
      ),
    ).toBe("1m 5s");
    expect(
      gitLabDuration({
        status: "SUCCESS",
        startedAt: "2026-09-20T12:00:00Z",
        duration: 3,
      }),
    ).toBe("3s");
    expect(
      gitLabDuration({ status: "PENDING", startedAt: null, duration: null }),
    ).toBe("—");
    expect(
      gitLabDuration({ status: "SUCCESS", startedAt: null, duration: NaN }),
    ).toBe("—");
  });
});
