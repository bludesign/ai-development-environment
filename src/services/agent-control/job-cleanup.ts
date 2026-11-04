import type { Prisma } from "@/generated/prisma/client";

// Terminal status can precede execution cleanup. Keep the job available for
// its owner's acknowledgement until the execution token has been cleared.
export const SETTLED_AGENT_JOB_WHERE = {
  status: { in: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] },
  executionToken: null,
} satisfies Prisma.AgentJobWhereInput;
