import "server-only";

import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

import type { SessionData } from "@/lib/workflows/session";

const MAX_SCRIPT_LENGTH = 50_000;
const SCRIPT_TIMEOUT_MS = 250;
const SCRIPT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024;
const SCRIPT_STACK_LIMIT_BYTES = 512 * 1024;

export async function evaluateWorkflowScript(
  sourceValue: string,
  sessionData: SessionData,
): Promise<unknown> {
  const source = sourceValue.trim();
  if (!source || source.length > MAX_SCRIPT_LENGTH) {
    throw new Error(
      `Workflow script must contain 1–${MAX_SCRIPT_LENGTH.toLocaleString()} characters`,
    );
  }
  const quickJs = await getQuickJS();
  const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
  try {
    return quickJs.evalCode(
      `"use strict"; const session = Object.freeze(${JSON.stringify(sessionData)}); (${source})(session);`,
      {
        memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
        maxStackSizeBytes: SCRIPT_STACK_LIMIT_BYTES,
        shouldInterrupt: shouldInterruptAfterDeadline(deadline),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Workflow script failed: ${
        message === "interrupted"
          ? `execution timed out after ${SCRIPT_TIMEOUT_MS}ms`
          : message
      }`,
    );
  }
}
