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
import { ModelCostsService } from "@/services/model-costs";
import { RunsService } from "@/services/runs";
import { CommandsService } from "@/services/commands";
import { DiskSpaceService } from "@/services/disk-space";
import { SystemStatusService } from "@/services/system-status";
import {
  WorkflowEventsService,
  WorkflowsService,
  WorkflowStepExecutor,
  WorkflowEventBridge,
  registerWorkflowAdapters,
} from "@/services/workflows";

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
  modelCostsService: ModelCostsService;
  runsService: RunsService;
  commandsService: CommandsService;
  diskSpaceService: DiskSpaceService;
  systemStatusService: SystemStatusService;
  workflowEventsService: WorkflowEventsService;
  workflowsService: WorkflowsService;
  workflowEventBridge: WorkflowEventBridge;
};

function createServerServices(): ServerServices {
  const prismaService = new PrismaService();
  const credentialService = new CredentialService();
  const workflowEventsService = new WorkflowEventsService();
  const agentControlService = new AgentControlService();
  const notificationsService = new NotificationsService(credentialService);
  const pollingService = new PollingService();
  const diskSpaceService = new DiskSpaceService(agentControlService);
  const commandsService = new CommandsService(
    agentControlService,
    notificationsService,
  );
  commandsService.startRuntime();
  const ccusageService = new CcusageService(agentControlService);
  const buildDataService = new BuildDataService(agentControlService);
  const telemetryService = new TelemetryService();
  const signingAssetsService = new SigningAssetsService(
    agentControlService,
    undefined,
    credentialService,
  );
  const modelCostsService = new ModelCostsService();
  const pushNotificationsService = new PushNotificationsService(
    undefined,
    credentialService,
    pollingService,
  );
  const runsService = new RunsService(
    notificationsService,
    agentControlService,
    diskSpaceService,
  );
  runsService.startReaper();
  const buildsService = new BuildsService(
    agentControlService,
    telemetryService,
    notificationsService,
    diskSpaceService,
  );
  const skillsService = new SkillsService(agentControlService);
  const codebasesService = new CodebasesService(
    agentControlService,
    skillsService,
  );
  const codebaseToolsService = new CodebaseToolsService(codebasesService);
  const jiraService = new JiraService(credentialService, workflowEventsService);
  const iosDevicesService = new IosDevicesService(undefined, credentialService);
  const gitHubActionsNotificationsService =
    new GitHubActionsNotificationsService(
      credentialService,
      notificationsService,
      pollingService,
      true,
      workflowEventsService,
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
    workflowEventsService,
  );
  const toolsService = new ToolsService(
    codebaseToolsService,
    buildsService,
    {
      codebases: codebasesService,
      telemetry: telemetryService,
      pushNotifications: pushNotificationsService,
      agents: agentControlService,
      // A thunk, not the instance: `workflowsService` is constructed below and
      // takes `toolsService` itself. Resolved when a workflow tool is called.
      workflows: () => workflowsService,
    },
    credentialService,
  );
  const workflowStepExecutor = new WorkflowStepExecutor();
  const workflowsService = new WorkflowsService(
    workflowEventsService,
    workflowStepExecutor,
    undefined,
    credentialService,
    agentControlService,
    notificationsService,
    runsService,
    worktreesService,
    commandsService,
  );
  registerWorkflowAdapters(workflowsService, workflowStepExecutor, {
    agentControl: agentControlService,
    jira: jiraService,
    github: gitHubService,
    worktrees: worktreesService,
    codebases: codebasesService,
    builds: buildsService,
    skills: skillsService,
    runs: runsService,
    commands: commandsService,
    notifications: notificationsService,
    pushNotifications: pushNotificationsService,
    tools: toolsService,
  });
  const workflowEventBridge = new WorkflowEventBridge(
    workflowEventsService,
    agentControlService,
  );
  workflowEventBridge.start();
  workflowsService.startRuntime();
  const systemStatusService = new SystemStatusService(
    ccusageService,
    diskSpaceService,
    pollingService,
  );
  systemStatusService.startRuntime();
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
    modelCostsService,
    runsService,
    commandsService,
    diskSpaceService,
    systemStatusService,
    toolsService,
    workflowEventsService,
    workflowsService,
    workflowEventBridge,
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
