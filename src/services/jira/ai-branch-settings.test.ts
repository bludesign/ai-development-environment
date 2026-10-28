import { beforeEach, expect, test, vi } from "vitest";
import { JiraService } from "./jira.service";
import { DEFAULT_JIRA_BRANCH_NAMING_PROMPT } from "@ai-development-environment/agent-contract/worktrees";
const database = vi.hoisted(() => ({
  jiraProject: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => database,
}));
const project = {
  id: "project",
  key: "APP",
  sources: [],
  branchNamingScript: "saved-script",
  branchNamingProvider: "CODEX",
  branchNamingModel: "saved-model",
  branchNamingPrompt: "{{ticket.title}}",
  branchNamingEffort: "low",
};
beforeEach(() => {
  vi.clearAllMocks();
  database.jiraProject.findUnique.mockResolvedValue(project);
  database.jiraProject.findMany.mockResolvedValue([project]);
});
test("existing projects default to JavaScript and new prompts omit description", async () => {
  const result = await new JiraService().listProjects();
  expect(result[0]!.branchNamingMode).toBe("JAVASCRIPT");
  expect(DEFAULT_JIRA_BRANCH_NAMING_PROMPT).not.toContain("ticket.description");
});
test("mode switching preserves saved prompt, model and JavaScript", async () => {
  await new JiraService().updateProjectAiBranchNaming({
    projectId: "project",
    mode: "JAVASCRIPT",
  });
  expect(database.jiraProject.update).toHaveBeenCalledWith({
    where: { id: "project" },
    data: { branchNamingMode: "JAVASCRIPT" },
  });
});
test("invalid prompt tokens are rejected before persistence", async () => {
  await expect(
    new JiraService().updateProjectAiBranchNaming({
      projectId: "project",
      mode: "AI",
      prompt: "{{ticket.secret}}",
    }),
  ).rejects.toThrow("Unsupported");
  expect(database.jiraProject.update).not.toHaveBeenCalled();
});

test("disabling AI preserves the saved configuration even when the unsaved prompt is invalid", async () => {
  await new JiraService().updateProjectAiBranchNaming({
    projectId: "project",
    mode: "JAVASCRIPT",
    prompt: "{{unsupported}}",
    model: "",
  });
  expect(database.jiraProject.update).toHaveBeenCalledWith({
    where: { id: "project" },
    data: { branchNamingMode: "JAVASCRIPT" },
  });
});
