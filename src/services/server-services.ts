import "server-only";

import { AgentControlService } from "@/services/agent-control";
import { CcusageService } from "@/services/ccusage";
import { BuildDataService } from "@/services/build-data";
import { CodebasesService, CodebaseToolsService } from "@/services/codebases";
import { GitHubService } from "@/services/github";
import { JiraService } from "@/services/jira";
import { PrismaService } from "@/services/prisma";
import { ToolsService } from "@/services/tools";
import { WorktreesService } from "@/services/worktrees";
import { SkillsService } from "@/services/skills";

export type ServerServices = {
  prismaService: PrismaService;
  agentControlService: AgentControlService;
  ccusageService: CcusageService;
  buildDataService: BuildDataService;
  codebasesService: CodebasesService;
  codebaseToolsService: CodebaseToolsService;
  jiraService: JiraService;
  gitHubService: GitHubService;
  toolsService: ToolsService;
  worktreesService: WorktreesService;
  skillsService: SkillsService;
};

function createServerServices(): ServerServices {
  const prismaService = new PrismaService();
  const agentControlService = new AgentControlService();
  const ccusageService = new CcusageService(agentControlService);
  const buildDataService = new BuildDataService(agentControlService);
  const skillsService = new SkillsService(agentControlService);
  const codebasesService = new CodebasesService(
    agentControlService,
    skillsService,
  );
  const codebaseToolsService = new CodebaseToolsService(codebasesService);
  const jiraService = new JiraService();
  const gitHubService = new GitHubService();
  const worktreesService = new WorktreesService(
    agentControlService,
    jiraService,
    gitHubService,
    skillsService,
  );
  return {
    prismaService,
    agentControlService,
    ccusageService,
    buildDataService,
    codebasesService,
    codebaseToolsService,
    jiraService,
    gitHubService,
    worktreesService,
    skillsService,
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
