import "server-only";

import { AgentControlService } from "@/services/agent-control";
import { CcusageService } from "@/services/ccusage";
import { BuildDataService } from "@/services/build-data";
import { BuildsService } from "@/services/builds";
import { CodebasesService, CodebaseToolsService } from "@/services/codebases";
import {
  GitHubActionsNotificationsService,
  GitHubService,
} from "@/services/github";
import { CacheServerService } from "@/services/cache-server";
import { JiraService } from "@/services/jira";
import { IosDevicesService } from "@/services/ios-devices";
import { PrismaService } from "@/services/prisma";
import { ToolsService } from "@/services/tools";
import { WorktreesService } from "@/services/worktrees";
import { SkillsService } from "@/services/skills";
import { TelemetryService } from "@/services/telemetry";
import { SigningAssetsService } from "@/services/signing-assets";
import { PushNotificationsService } from "@/services/push-notifications";
import { CredentialService } from "@/services/credentials";
import { NotificationsService } from "@/services/notifications";
import { PollingService } from "@/services/polling";
import { RunsService } from "@/services/runs";

export type ServerServices = {
  prismaService: PrismaService;
  credentialService: CredentialService;
  agentControlService: AgentControlService;
  ccusageService: CcusageService;
  buildDataService: BuildDataService;
  buildsService: BuildsService;
  codebasesService: CodebasesService;
  codebaseToolsService: CodebaseToolsService;
  jiraService: JiraService;
  iosDevicesService: IosDevicesService;
  gitHubService: GitHubService;
  gitHubActionsNotificationsService: GitHubActionsNotificationsService;
  cacheServerService: CacheServerService;
  toolsService: ToolsService;
  worktreesService: WorktreesService;
  skillsService: SkillsService;
  telemetryService: TelemetryService;
  signingAssetsService: SigningAssetsService;
  pushNotificationsService: PushNotificationsService;
  notificationsService: NotificationsService;
  pollingService: PollingService;
  runsService: RunsService;
};

function createServerServices(): ServerServices {
  const prismaService = new PrismaService();
  const credentialService = new CredentialService();
  const agentControlService = new AgentControlService();
  const ccusageService = new CcusageService(agentControlService);
  const buildDataService = new BuildDataService(agentControlService);
  const telemetryService = new TelemetryService();
  const signingAssetsService = new SigningAssetsService(
    agentControlService,
    undefined,
    credentialService,
  );
  const pollingService = new PollingService();
  const pushNotificationsService = new PushNotificationsService(
    undefined,
    credentialService,
    pollingService,
  );
  const notificationsService = new NotificationsService(credentialService);
  const runsService = new RunsService(
    notificationsService,
    agentControlService,
  );
  runsService.startReaper();
  const buildsService = new BuildsService(
    agentControlService,
    telemetryService,
    notificationsService,
  );
  const skillsService = new SkillsService(agentControlService);
  const codebasesService = new CodebasesService(
    agentControlService,
    skillsService,
  );
  const codebaseToolsService = new CodebaseToolsService(codebasesService);
  const jiraService = new JiraService(credentialService);
  const iosDevicesService = new IosDevicesService(undefined, credentialService);
  const gitHubActionsNotificationsService =
    new GitHubActionsNotificationsService(
      credentialService,
      notificationsService,
      pollingService,
    );
  const gitHubService = new GitHubService(
    true,
    credentialService,
    pollingService,
    () => gitHubActionsNotificationsService.configurationChanged(),
  );
  const cacheServerService = new CacheServerService(credentialService);
  const worktreesService = new WorktreesService(
    agentControlService,
    jiraService,
    gitHubService,
    skillsService,
  );
  return {
    prismaService,
    credentialService,
    agentControlService,
    ccusageService,
    buildDataService,
    buildsService,
    codebasesService,
    codebaseToolsService,
    jiraService,
    iosDevicesService,
    gitHubService,
    gitHubActionsNotificationsService,
    cacheServerService,
    worktreesService,
    skillsService,
    telemetryService,
    signingAssetsService,
    pushNotificationsService,
    notificationsService,
    pollingService,
    runsService,
    toolsService: new ToolsService(
      codebaseToolsService,
      buildsService,
      {
        codebases: codebasesService,
        telemetry: telemetryService,
        pushNotifications: pushNotificationsService,
        agents: agentControlService,
      },
      credentialService,
    ),
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
