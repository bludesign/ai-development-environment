import type { PrismaClient } from "../../src/generated/prisma/client";

import { ids } from "./ids";
import { minutesAgo, minutesFromNow } from "./time";

const PRODUCT_TOKEN = "FQxTRdPVgtpo5RqhiOiCCQtHoIdL5KLtWLxQ4bjGiGA";
const ASSISTANT_TOKEN = "uS5K-Pyg0YeA0mjR8ejxbD3eO7fYLo7ZZNwIdfFDkNU";

const requestHeaders = JSON.stringify([
  { name: "accept", value: "text/event-stream" },
  { name: "authorization", value: "Bearer demo-customer-token" },
  { name: "x-request-id", value: "req_acme_8452" },
]);

export async function seedSse(prisma: PrismaClient): Promise<void> {
  await prisma.sseEndpoint.createMany({
    data: [
      {
        id: ids.sse.productFeed,
        token: PRODUCT_TOKEN,
        name: "Product recommendation stream",
        description:
          "Transforms upstream recommendation events for the storefront client.",
        mode: "FORWARD",
        forwardUrl: "https://events.api.acme.example/v1/recommendations",
        requestScript: `const token = forwarding.headers.get("authorization");\nawait storage.set("last-auth-scheme", token?.split(" ")[0] ?? "none");\nforwarding.headers.set("x-sse-proxy", "acme");\nreturn { forwarding };`,
        responseScript: `if (phase === "event" && event?.event === "message") {\n  const separator = event.data.indexOf("\\n\\n");\n  if (separator >= 0) return { splits: [{ target: "BOTH", offset: separator, discard: 2 }] };\n}\nreturn undefined;`,
        historyBufferMode: "CONCATENATE",
      },
      {
        id: ids.sse.assistant,
        token: ASSISTANT_TOKEN,
        name: "Assistant response stream",
        description:
          "Interactive development endpoint paused for response inspection.",
        mode: "BREAKPOINT",
        forwardUrl: "https://assistant.api.acme.example/v1/responses",
        breakpointTimeoutMs: 300_000,
      },
    ],
  });

  await prisma.sseMockEventTemplate.createMany({
    data: [
      {
        id: ids.sse.displayCardTemplate,
        endpointId: ids.sse.productFeed,
        name: "Display product card",
        eventName: "display_card",
        data: JSON.stringify({
          title: "Trail Running Shoes",
          price: "$129",
          image: "https://cdn.acme.example/trail-shoes.png",
        }),
        eventId: "evt_1349872",
      },
      {
        id: "sse-template-loading",
        endpointId: ids.sse.productFeed,
        name: "Loading state",
        eventName: "loading",
        data: JSON.stringify({ text: "Finding recommendations" }),
      },
      {
        id: "sse-template-followup",
        endpointId: ids.sse.productFeed,
        name: "Follow-up text",
        data: "What would you like to explore next?",
      },
    ],
  });

  await prisma.sseMockComposition.create({
    data: {
      id: ids.sse.mockComposition,
      endpointId: ids.sse.productFeed,
      name: "Personalized product journey",
      statusCode: 200,
      headersJson: JSON.stringify([
        { name: "Content-Type", value: "text/event-stream" },
        { name: "X-Mock-Scenario", value: "product-journey" },
      ]),
      blocks: {
        create: [
          {
            id: "sse-block-loading",
            position: 0,
            kind: "EVENT",
            templateId: "sse-template-loading",
          },
          { id: "sse-block-delay", position: 1, kind: "DELAY", delayMs: 750 },
          {
            id: "sse-block-display-card",
            position: 2,
            kind: "EVENT",
            templateId: ids.sse.displayCardTemplate,
          },
          {
            id: "sse-block-script",
            position: 3,
            kind: "SCRIPT",
            script: `const count = await storage.increment("mock-runs", 1);\nreturn { event: "metrics", data: JSON.stringify({ mockRun: count.value }) };`,
          },
          {
            id: "sse-block-followup",
            position: 4,
            kind: "EVENT",
            templateId: "sse-template-followup",
          },
          {
            id: "sse-block-custom-complete",
            position: 5,
            kind: "EVENT",
            eventName: "complete",
            eventData: JSON.stringify({ reason: "mock_finished" }),
            eventId: "evt_complete",
          },
        ],
      },
    },
  });
  await prisma.sseEndpoint.update({
    where: { id: ids.sse.productFeed },
    data: { activeMockCompositionId: ids.sse.mockComposition },
  });

  await prisma.sseScriptStorageEntry.createMany({
    data: [
      {
        key: "mock-runs",
        valueJson: "42",
        version: 7,
        updatedBy: "mock-script",
      },
      {
        key: "last-auth-scheme",
        valueJson: JSON.stringify("Bearer"),
        version: 3,
        updatedBy: "request-script",
      },
      {
        key: "tenant-config",
        valueJson: JSON.stringify({
          tenant: "acme-storefront",
          locale: "en-US",
          experiments: ["recommendations-v2"],
        }),
        version: 12,
        updatedBy: "graphql",
      },
    ],
  });

  await prisma.sseRequestHistory.create({
    data: {
      id: ids.sse.history,
      endpointId: ids.sse.productFeed,
      endpointName: "Product recommendation stream",
      endpointToken: PRODUCT_TOKEN,
      mode: "FORWARD",
      status: "COMPLETED",
      method: "POST",
      requestUrl: `http://localhost:3000/api/public/sse/${PRODUCT_TOKEN}`,
      requestHeadersJson: requestHeaders,
      requestBody: JSON.stringify({
        customerId: "customer_284",
        query: "running shoes",
      }),
      effectiveUrl: "https://events.api.acme.example/v1/recommendations",
      effectiveMethod: "POST",
      effectiveHeadersJson: JSON.stringify([
        ...JSON.parse(requestHeaders),
        { name: "x-sse-proxy", value: "acme" },
      ]),
      effectiveBody: JSON.stringify({
        customerId: "customer_284",
        query: "running shoes",
      }),
      upstreamStatus: 200,
      upstreamHeadersJson: JSON.stringify([
        { name: "content-type", value: "text/event-stream" },
        { name: "x-upstream-request-id", value: "up_84291" },
      ]),
      responseStatus: 200,
      responseHeadersJson: JSON.stringify([
        { name: "content-type", value: "text/event-stream" },
        { name: "cache-control", value: "no-cache, no-transform" },
      ]),
      outcome: "COMPLETED",
      configSnapshotJson: JSON.stringify({
        mode: "FORWARD",
        deliveryBufferMode: "STANDARD",
        historyBufferMode: "CONCATENATE",
        heartbeatIntervalMs: 15000,
      }),
      storedBytes: 284,
      startedAt: minutesAgo(18),
      firstEventAt: minutesAgo(17),
      finishedAt: minutesAgo(16),
      durationMs: 122_400,
      events: {
        create: [
          {
            id: "sse-event-source-card",
            sequence: 0,
            logicalIndex: 0,
            stage: "SOURCE",
            correlationId: "corr-card",
            eventName: "display_card",
            data: JSON.stringify({
              title: "Trail Running Shoes",
              price: "$129",
            }),
            eventId: "1349872",
          },
          {
            id: "sse-event-emitted-card",
            sequence: 1,
            logicalIndex: 0,
            stage: "EMITTED",
            correlationId: "corr-card",
            eventName: "display_card",
            data: JSON.stringify({
              title: "Trail Running Shoes",
              price: "$129",
            }),
            eventId: "1349872",
            fanOutIndex: 0,
          },
          {
            id: "sse-event-source-text",
            sequence: 2,
            logicalIndex: 1,
            stage: "SOURCE",
            correlationId: "corr-text",
            eventName: "text",
            data: "Good morning\nHow are you?",
            eventId: "1349872",
          },
          {
            id: "sse-event-emitted-text",
            sequence: 3,
            logicalIndex: 1,
            stage: "EMITTED",
            correlationId: "corr-text",
            eventName: "text",
            data: "Good morning\nHow are you?",
            eventId: "1349872",
            fanOutIndex: 0,
          },
          {
            id: "sse-event-source-loading",
            sequence: 4,
            logicalIndex: 2,
            stage: "SOURCE",
            correlationId: "corr-loading",
            eventName: "loading",
            data: JSON.stringify({ text: "Loading" }),
            eventId: "1349872",
          },
          {
            id: "sse-event-emitted-loading",
            sequence: 5,
            logicalIndex: 2,
            stage: "EMITTED",
            correlationId: "corr-loading",
            eventName: "loading",
            data: JSON.stringify({ text: "Loading" }),
            eventId: "1349872",
            fanOutIndex: 0,
          },
          {
            id: "sse-event-source-followup",
            sequence: 6,
            logicalIndex: 3,
            stage: "SOURCE",
            correlationId: "corr-followup",
            eventName: "text",
            data: "What would you like to work on?",
            eventId: "1349872",
          },
          {
            id: "sse-event-emitted-followup",
            sequence: 7,
            logicalIndex: 3,
            stage: "EMITTED",
            correlationId: "corr-followup",
            eventName: "text",
            data: "What would you like to work on?",
            eventId: "1349872",
            fanOutIndex: 0,
          },
        ],
      },
    },
  });

  await prisma.sseRequestHistory.create({
    data: {
      id: ids.sse.breakpointHistory,
      endpointId: ids.sse.assistant,
      endpointName: "Assistant response stream",
      endpointToken: ASSISTANT_TOKEN,
      mode: "BREAKPOINT",
      status: "WAITING",
      method: "POST",
      requestUrl: `http://localhost:3000/api/public/sse/${ASSISTANT_TOKEN}`,
      requestHeadersJson: requestHeaders,
      requestBody: JSON.stringify({
        prompt: "Summarize the release plan",
        conversationId: "conversation_948",
      }),
      configSnapshotJson: JSON.stringify({
        mode: "BREAKPOINT",
        breakpointTimeoutMs: 300000,
      }),
      startedAt: minutesAgo(1),
      breakpoint: {
        create: {
          id: ids.sse.breakpoint,
          endpointId: ids.sse.assistant,
          status: "WAITING",
          version: 1,
          expiresAt: minutesFromNow(4),
        },
      },
    },
  });

  await prisma.sseHistoryViewSettings.createMany({
    data: [
      {
        view: "STREAMS",
        columnsJson: JSON.stringify([
          "endpoint",
          "startedAt",
          "method",
          "mode",
          "status",
          "responseStatus",
          "eventCount",
          "duration",
        ]),
      },
      {
        view: "EVENTS",
        columnsJson: JSON.stringify([
          "endpoint",
          "createdAt",
          "eventName",
          "stage",
          "eventId",
          "data",
          "sequence",
          "mode",
        ]),
      },
    ],
  });
  await prisma.sseHistoryColumnPreset.create({
    data: {
      id: "sse-preset-debug",
      view: "EVENTS",
      name: "Transformation debugging",
      columnsJson: JSON.stringify([
        "createdAt",
        "endpoint",
        "eventName",
        "stage",
        "eventId",
        "data",
        "sequence",
      ]),
    },
  });
  await prisma.sseHistorySavedFilter.create({
    data: {
      id: "sse-filter-forward",
      view: "STREAMS",
      name: "Forwarded streams",
      definitionJson: JSON.stringify({ mode: "FORWARD" }),
    },
  });
}
