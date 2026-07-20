export const pushNotificationsOpenApiDocument = {
  tags: [
    {
      name: "APNs Devices",
      description:
        "Register APNs device tokens for push notification targeting.",
    },
  ],
  paths: {
    "/api/ios/apns-devices": {
      post: {
        tags: ["APNs Devices"],
        summary: "Register or refresh an APNs device",
        operationId: "registerApnsDevice",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ApnsDeviceRegistrationInput",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Existing registration refreshed",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ApnsDeviceRegistrationResponse",
                },
              },
            },
          },
          "201": {
            description: "Registration created",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/ApnsDeviceRegistrationResponse",
                },
              },
            },
          },
          "400": { description: "Invalid registration" },
          "413": { description: "Request body exceeds 32 KiB" },
          "415": { description: "Content-Type is not JSON" },
          "429": { description: "Source IP exceeded 120 requests per minute" },
        },
      },
    },
  },
  components: {
    schemas: {
      ApnsDeviceRegistrationInput: {
        type: "object",
        additionalProperties: false,
        required: [
          "clientRegistrationId",
          "token",
          "tokenEncoding",
          "topic",
          "environment",
          "supportedPushTypes",
          "displayName",
        ],
        properties: {
          clientRegistrationId: { type: "string", maxLength: 200 },
          token: { type: "string", description: "32-byte APNs token" },
          tokenEncoding: { type: "string", enum: ["HEX", "BASE64"] },
          topic: { type: "string", maxLength: 255 },
          environment: { type: "string", enum: ["SANDBOX", "PRODUCTION"] },
          supportedPushTypes: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "alert",
                "background",
                "complication",
                "controls",
                "fileprovider",
                "liveactivity",
                "location",
                "mdm",
                "pushtotalk",
                "voip",
                "widgets",
              ],
            },
          },
          displayName: { type: "string", maxLength: 120 },
          deviceModel: { type: "string", maxLength: 120 },
          osVersion: { type: "string", maxLength: 50 },
          appVersion: { type: "string", maxLength: 50 },
          appBuild: { type: "string", maxLength: 50 },
          locale: { type: "string", maxLength: 35 },
          pushMagic: {
            type: "string",
            maxLength: 500,
            description: "Required for MDM registrations",
          },
        },
      },
      ApnsDeviceRegistrationResponse: {
        type: "object",
        required: ["id", "created", "status", "lastRegisteredAt"],
        properties: {
          id: { type: "string" },
          created: { type: "boolean" },
          status: { type: "string" },
          lastRegisteredAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;
