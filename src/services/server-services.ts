import "server-only";

import { AgentControlService } from "@/services/agent-control";
import { CcusageService } from "@/services/ccusage";
import { BuildDataService } from "@/services/build-data";
import { BuildsService } from "@/services/builds";
import { CodebasesService, CodebaseToolsService } from "@/services/codebases";
import { GitHubService } from "@/services/github";
import { JiraService } from "@/services/jira";
import { IosDevicesService } from "@/services/ios-devices";
import { PrismaService } from "@/services/prisma";
import { ToolsService } from "@/services/tools";
import { WorktreesService } from "@/services/worktrees";
import { SkillsService } from "@/services/skills";
import { TelemetryService } from "@/services/telemetry";
import { SigningAssetsService } from "@/services/signing-assets";
import { PushNotificationsService } from "@/services/push-notifications";

export type ServerServices = {
  prismaService: PrismaService;
  agentControlService: AgentControlService;
  ccusageService: CcusageService;
  buildDataService: BuildDataService;
  buildsService: BuildsService;
  codebasesService: CodebasesService;
  codebaseToolsService: CodebaseToolsService;
  jiraService: JiraService;
  iosDevicesService: IosDevicesService;
  gitHubService: GitHubService;
  toolsService: ToolsService;
  worktreesService: WorktreesService;
  skillsService: SkillsService;
  telemetryService: TelemetryService;
  signingAssetsService: SigningAssetsService;
  pushNotificationsService: PushNotificationsService;
};

function createServerServices(): ServerServices {
  const prismaService = new PrismaService();
  const agentControlService = new AgentControlService();
  const ccusageService = new CcusageService(agentControlService);
  const buildDataService = new BuildDataService(agentControlService);
  const telemetryService = new TelemetryService();
  const signingAssetsService = new SigningAssetsService(agentControlService);
  const pushNotificationsService = new PushNotificationsService();
  if (process.env.NODE_ENV !== "test") {
    pushNotificationsService.startBackgroundRecovery();
  }
  const buildsService = new BuildsService(
    agentControlService,
    telemetryService,
  );
  const skillsService = new SkillsService(agentControlService);
  const codebasesService = new CodebasesService(
    agentControlService,
    skillsService,
  );
  const codebaseToolsService = new CodebaseToolsService(codebasesService);
  const jiraService = new JiraService();
  const iosDevicesService = new IosDevicesService();
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
    buildsService,
    codebasesService,
    codebaseToolsService,
    jiraService,
    iosDevicesService,
    gitHubService,
    worktreesService,
    skillsService,
    telemetryService,
    signingAssetsService,
    pushNotificationsService,
    toolsService: new ToolsService(codebaseToolsService, buildsService),
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
