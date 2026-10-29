import { expect, test, vi } from "vitest";
import { createCodebaseToolGroup } from "./codebases";

test("branch cleanup preserves reviewed tips and explicit force, validates before dispatch and hides job payloads", async () => {
  const deleteBranches = vi.fn().mockResolvedValue({
    jobs: [
      {
        id: "job",
        agentId: "agent",
        codebaseId: "repo",
        kind: "DELETE_BRANCHES",
        status: "QUEUED",
        error: null,
        payloadJson: "private payload",
      },
    ],
    skipped: [],
  });
  const group = createCodebaseToolGroup(
    {} as never,
    { deleteBranches } as never,
  );
  const cleanup = group.tools.find(
    ({ name }) => name === "delete_codebase_branches",
  )!;
  const input = {
    requestId: "review",
    force: true,
    targets: [
      {
        codebaseId: "repo",
        branch: "feature/old",
        expectedHeadSha: "a".repeat(40),
      },
    ],
  };
  expect(cleanup.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  });
  const output = await cleanup.invoke(input);
  expect(JSON.stringify(output)).not.toContain("private payload");
  expect(deleteBranches).toHaveBeenCalledWith(input);
  deleteBranches.mockClear();
  await expect(
    cleanup.invoke({
      ...input,
      targets: [{ ...input.targets[0], expectedHeadSha: "a".repeat(41) }],
    }),
  ).rejects.toThrow();
  expect(deleteBranches).not.toHaveBeenCalled();
});
