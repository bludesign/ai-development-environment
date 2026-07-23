import { renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { useRunLabels } from "./run-labels";

const labels = () => renderHook(() => useRunLabels()).result.current;

describe("useRunLabels", () => {
  test("localizes the phases the run service writes", () => {
    const t = labels();
    expect(t.phase("IMPORTED_SYNCED")).toBe("Imported and synced");
    expect(t.phase("WAITING_FOR_ANSWER")).toBe("Waiting for answer");
    expect(t.phase("SUPERSEDED_BY_FOLLOW_UP")).toBe("Superseded by follow-up");
    expect(t.phase("PREPARE_ANSWER_REVISION_FAILED")).toBe(
      "Answer revision preparation failed",
    );
  });

  test("localizes statuses, checkpoint kinds, follow-up modes, and tool calls", () => {
    const t = labels();
    expect(t.status("COMPLETED")).toBe("Completed");
    expect(t.checkpointKind("PRE_ANSWER_REVISION")).toBe(
      "Before answer revision",
    );
    expect(t.followUpMode("PLAN_PLAY")).toBe("Plan run");
    expect(t.toolCallStatus("OBSERVED")).toBe("Observed");
  });

  test("localizes the event types the agent emits itself", () => {
    const t = labels();
    expect(t.eventType("SYSTEM")).toBe("System");
    expect(t.eventType("QUESTION")).toBe("Question");
  });

  test("keeps provider-supplied event types readable without a message key", () => {
    // Codex JSON-RPC methods and OpenCode SDK events arrive verbatim, so this
    // set cannot be enumerated in the message catalog.
    expect(labels().eventType("MESSAGE_PART_UPDATED")).toBe(
      "Message Part Updated",
    );
  });
});
