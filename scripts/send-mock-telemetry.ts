import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TELEMETRY_ADDRESS = "http://127.0.0.1:3000";

type Fetch = typeof fetch;

export function telemetryAddress(args: string[]): string {
  let value = DEFAULT_TELEMETRY_ADDRESS;
  if (args.length > 0) {
    if (args[0] === "--address") {
      if (!args[1] || args.length > 2) {
        throw new Error("Usage: send-mock-telemetry.ts [address]");
      }
      value = args[1];
    } else if (args[0]!.startsWith("--address=")) {
      if (args.length > 1) {
        throw new Error("Usage: send-mock-telemetry.ts [address]");
      }
      value = args[0]!.slice("--address=".length);
    } else {
      if (args.length > 1 || args[0]!.startsWith("-")) {
        throw new Error("Usage: send-mock-telemetry.ts [address]");
      }
      value = args[0]!;
    }
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Address must be a valid HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Address must be an HTTP(S) origin without a path, credentials, query, or fragment",
    );
  }
  return url.origin;
}

export function mockTelemetryPayloads(
  sequence: number,
  sessionId: string,
  now = new Date(),
) {
  const levels = ["debug", "info", "warning", "error"] as const;
  const screens = ["Home", "Catalog", "Checkout", "Profile"] as const;
  const level = levels[sequence % levels.length]!;
  const screenName = screens[sequence % screens.length]!;
  const time = now.toISOString();
  const buildId = "mock-build";
  const message = `Mock console log ${sequence}: the simulated ${level} operation on ${screenName} completed after processing a deliberately verbose test payload. This longer message is intended to exercise truncation, compact row sizing, expansion, searching, copying, and exported table layout without requiring a real application log.`;
  return {
    consoleLog: {
      message,
      time,
      level,
      category: sequence % 2 === 0 ? "mock.network" : "mock.lifecycle",
      buildId,
      sessionId,
      attributes: {
        sequence,
        screenName,
        cache: { hit: sequence % 3 !== 0 },
        durationMs: 100 + sequence * 7,
      },
    },
    analyticsEvent: {
      eventName: `mock_event_${sequence}`,
      kind: sequence % 2 === 0 ? "product" : "interaction",
      screenName,
      time,
      defaultParameters: {
        appVersion: "1.0-mock",
        platform: "iOS",
      },
      additionalParameters: {
        sequence,
        selected: sequence % 2 === 0,
      },
      buildId,
      sessionId,
    },
  };
}

async function postJson(
  fetchImpl: Fetch,
  url: string,
  body: unknown,
): Promise<void> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${url} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
}

export async function sendMockTelemetry(
  address: string,
  sequence: number,
  sessionId: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const { consoleLog, analyticsEvent } = mockTelemetryPayloads(
    sequence,
    sessionId,
  );
  await Promise.all([
    postJson(fetchImpl, `${address}/api/telemetry/console-logs`, consoleLog),
    postJson(
      fetchImpl,
      `${address}/api/telemetry/analytics-events`,
      analyticsEvent,
    ),
  ]);
}

export async function runMockTelemetry(args = process.argv.slice(2)) {
  const address = telemetryAddress(args);
  const sessionId = `mock-session-${Date.now()}`;
  let sequence = 1;
  let sending = false;

  const tick = async () => {
    if (sending) return;
    sending = true;
    const current = sequence;
    sequence += 1;
    try {
      await sendMockTelemetry(address, current, sessionId);
      console.log(`Sent mock telemetry ${current} to ${address}`);
    } catch (error) {
      console.error(
        `Failed to send mock telemetry ${current}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      sending = false;
    }
  };

  console.log(`Sending mock console logs and analytics events to ${address}`);
  console.log("Press Ctrl+C to stop.");
  await tick();
  const timer = setInterval(() => void tick(), 1_000);
  await new Promise<void>((finish) => {
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      finish();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void runMockTelemetry().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
