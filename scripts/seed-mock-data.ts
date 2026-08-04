/**
 * Mock data seeder. Populates an isolated SQLite database (prisma/mock.db by default) with
 * generic "Acme" data so every page renders fully for screenshots. Run via:
 *
 *   DATABASE_URL=file:./prisma/mock.db tsx scripts/seed-mock-data.ts
 *
 * The database must already have the schema applied (prisma migrate deploy). Seeders assume
 * an empty database and run in dependency order.
 */
import { createMockPrismaClient, mockDatabasePath } from "./mock-data/prisma";
import { seedSettings } from "./mock-data/settings";
import { seedAgents } from "./mock-data/agents";
import { seedCodebases } from "./mock-data/codebases";
import { seedApps } from "./mock-data/apps";
import { seedRuns } from "./mock-data/runs";
import { seedBuilds } from "./mock-data/builds";
import { seedDevices } from "./mock-data/devices";
import { seedSkills } from "./mock-data/skills";
import { seedTools } from "./mock-data/tools";
import { seedCommands } from "./mock-data/commands";
import { seedTelemetry } from "./mock-data/telemetry";
import { seedNotifications } from "./mock-data/notifications";
import { seedSigning } from "./mock-data/signing";
import { seedCredentials } from "./mock-data/credentials";
import { seedGitHub } from "./mock-data/github";
import { seedJira, seedJiraWebhooks } from "./mock-data/jira";
import { seedWorkflows } from "./mock-data/workflows";
import { seedCosts } from "./mock-data/costs";
import { seedBuildData } from "./mock-data/build-data";

type Seeder = {
  name: string;
  run: (prisma: ReturnType<typeof createMockPrismaClient>) => Promise<void>;
};

const seeders: Seeder[] = [
  { name: "settings", run: seedSettings },
  { name: "agents", run: seedAgents },
  { name: "codebases", run: seedCodebases },
  { name: "apps", run: seedApps },
  { name: "runs", run: seedRuns },
  { name: "builds", run: seedBuilds },
  { name: "devices", run: seedDevices },
  { name: "skills", run: seedSkills },
  { name: "tools", run: seedTools },
  { name: "commands", run: seedCommands },
  { name: "telemetry", run: seedTelemetry },
  { name: "notifications", run: seedNotifications },
  { name: "signing", run: seedSigning },
  { name: "credentials", run: seedCredentials },
  { name: "github", run: seedGitHub },
  { name: "jira", run: seedJira },
  { name: "jira-webhooks", run: seedJiraWebhooks },
  { name: "workflows", run: seedWorkflows },
  { name: "costs", run: seedCosts },
  { name: "build-data", run: seedBuildData },
];

async function main(): Promise<void> {
  const prisma = createMockPrismaClient();
  console.log(`Seeding mock data into ${mockDatabasePath()}`);
  try {
    for (const seeder of seeders) {
      const start = Date.now();
      await seeder.run(prisma);
      console.log(`  ✓ ${seeder.name} (${Date.now() - start}ms)`);
    }
    console.log("Mock data seeding complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Mock data seeding failed:");
  console.error(error);
  process.exit(1);
});
