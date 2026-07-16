import "server-only";

import { AgentControlService } from "@/services/agent-control";
import { CcusageService } from "@/services/ccusage";
import { CodebasesService, CodebaseToolsService } from "@/services/codebases";
import { GitHubService } from "@/services/github";
import { JiraService } from "@/services/jira";
import { PrismaService } from "@/services/prisma";
import { ToolsService } from "@/services/tools";
import { WorktreesService } from "@/services/worktrees";

export type ServerServices = {
  prismaService: PrismaService;
  agentControlService: AgentControlService;
  ccusageService: CcusageService;
  codebasesService: CodebasesService;
  codebaseToolsService: CodebaseToolsService;
  jiraService: JiraService;
  gitHubService: GitHubService;
  toolsService: ToolsService;
  worktreesService: WorktreesService;
};

function createServerServices(): ServerServices {
  const prismaService = new PrismaService();
  const agentControlService = new AgentControlService();
  const ccusageService = new CcusageService(agentControlService);
  const codebasesService = new CodebasesService(agentControlService);
  const codebaseToolsService = new CodebaseToolsService(codebasesService);
  const jiraService = new JiraService();
  const gitHubService = new GitHubService();
  const worktreesService = new WorktreesService(
    agentControlService,
    jiraService,
    gitHubService,
  );
  return {
    prismaService,
    agentControlService,
    ccusageService,
    codebasesService,
    codebaseToolsService,
    jiraService,
    gitHubService,
    worktreesService,
    toolsService: new ToolsService(codebaseToolsService),
  };
}

const globalForServerServices = globalThis as typeof globalThis & {
  serverServices?: ServerServices;
};

export function getServerServices(): ServerServices {
  return (
    globalForServerServices.serverServices ??
    (globalForServerServices.serverServices = createServerServices())
  );
}
