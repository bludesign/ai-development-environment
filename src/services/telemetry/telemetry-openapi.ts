const jsonValue = {
  description:
    "Any JSON value; objects may be nested to a maximum depth of 10.",
} as const;

const dictionary = {
  type: "object",
  additionalProperties: jsonValue,
  maxProperties: 500,
} as const;

const coreString = { type: "string", minLength: 1, maxLength: 256 } as const;
const time = {
  type: "string",
  format: "date-time",
  description: "ISO-8601 timestamp including Z or an explicit UTC offset.",
} as const;

const ignoredServerFields = {
  id: {
    type: "string",
    readOnly: true,
    description: "Server-owned. Any client-supplied value is ignored.",
  },
  entryType: {
    type: "string",
    readOnly: true,
    description: "Server-owned. Any client-supplied value is ignored.",
  },
  receivedAt: {
    type: "string",
    format: "date-time",
    readOnly: true,
    description: "Server-owned. Any client-supplied value is ignored.",
  },
  deviceIp: {
    type: "string",
    readOnly: true,
    description: "Server-owned. Any client-supplied value is ignored.",
  },
  highlightColor: {
    type: "string",
    readOnly: true,
    description: "Server-owned. Any client-supplied value is ignored.",
  },
  separatorKind: {
    type: "string",
    readOnly: true,
    description: "Server-owned. Any client-supplied value is ignored.",
  },
  separatorName: {
    type: "string",
    readOnly: true,
    description: "Server-owned. Any client-supplied value is ignored.",
  },
} as const;

const responseSchema = {
  type: "object",
  required: ["collected", "items"],
  properties: {
    collected: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "receivedAt", "deviceIp"],
        properties: {
          id: { type: "string", format: "uuid" },
          receivedAt: { type: "string", format: "date-time" },
          deviceIp: { type: "string" },
        },
      },
    },
  },
} as const;

function endpoint(schema: object, example: object, summary: string) {
  return {
    post: {
      tags: ["Telemetry"],
      summary,
      description:
        "Unauthenticated ingestion. Accepts one record or an atomic `{ items: [...] }` batch of at most 500 records. The request body is capped at 2 MiB.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              oneOf: [
                schema,
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["items"],
                  properties: {
                    items: {
                      type: "array",
                      minItems: 1,
                      maxItems: 500,
                      items: schema,
                    },
                  },
                },
              ],
            },
            examples: {
              single: { value: example },
              batch: { value: { items: [example] } },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Records collected",
          content: { "application/json": { schema: responseSchema } },
        },
        "202": {
          description: "Payload valid but collection is disabled",
          content: { "application/json": { schema: responseSchema } },
        },
        "400": { $ref: "#/components/responses/TelemetryBadRequest" },
        "413": { $ref: "#/components/responses/TelemetryPayloadTooLarge" },
        "415": { $ref: "#/components/responses/TelemetryUnsupportedMediaType" },
        "500": { $ref: "#/components/responses/InternalError" },
      },
    },
  } as const;
}

export const telemetryOpenApiDocument = {
  tags: [{ name: "Telemetry" }],
  paths: {
    "/api/telemetry/console-logs": endpoint(
      { $ref: "#/components/schemas/ConsoleLogInput" },
      {
        message: "Checkout completed",
        time: "2026-07-20T18:30:00.000Z",
        level: "info",
        category: "checkout",
        buildId: "build-123",
        sessionId: "session-456",
        attributes: { durationMs: 412, cache: { hit: true } },
      },
      "Collect console logs",
    ),
    "/api/telemetry/analytics-events": endpoint(
      { $ref: "#/components/schemas/AnalyticsEventInput" },
      {
        eventName: "checkout_completed",
        kind: "product",
        screenName: "Checkout",
        time: "2026-07-20T18:30:00.000Z",
        defaultParameters: { appVersion: "1.0" },
        additionalParameters: { cartItems: 3 },
        buildId: "build-123",
        sessionId: "session-456",
      },
      "Collect analytics events",
    ),
  },
  components: {
    schemas: {
      ConsoleLogInput: {
        type: "object",
        additionalProperties: false,
        required: [
          "message",
          "time",
          "level",
          "category",
          "buildId",
          "sessionId",
          "attributes",
        ],
        properties: {
          ...ignoredServerFields,
          message: { type: "string", minLength: 1, maxLength: 65536 },
          time,
          level: coreString,
          category: coreString,
          buildId: coreString,
          sessionId: coreString,
          attributes: dictionary,
        },
      },
      AnalyticsEventInput: {
        type: "object",
        additionalProperties: false,
        required: [
          "eventName",
          "kind",
          "screenName",
          "time",
          "defaultParameters",
          "additionalParameters",
          "buildId",
          "sessionId",
        ],
        properties: {
          ...ignoredServerFields,
          eventName: coreString,
          kind: coreString,
          screenName: coreString,
          time,
          defaultParameters: dictionary,
          additionalParameters: dictionary,
          buildId: coreString,
          sessionId: coreString,
        },
      },
    },
    responses: {
      TelemetryBadRequest: {
        description: "Malformed or invalid telemetry payload",
      },
      TelemetryPayloadTooLarge: {
        description: "Request exceeds the 2 MiB limit",
      },
      TelemetryUnsupportedMediaType: {
        description: "Content-Type is not application/json",
      },
    },
  },
} as const;
