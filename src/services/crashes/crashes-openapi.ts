const errorResponse = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

const crashSummary = {
  type: "object",
  required: ["id", "status", "url"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: {
      type: "string",
      enum: [
        "PENDING",
        "WAITING_FOR_AGENT",
        "SYMBOLICATING",
        "SYMBOLICATED",
        "PARTIALLY_SYMBOLICATED",
        "MISSING_DSYMS",
        "FAILED",
      ],
    },
    url: {
      type: "string",
      description: "Dashboard path of the crash, relative to the server.",
    },
  },
} as const;

const metadataFields = {
  buildId: {
    type: "string",
    maxLength: 200,
    description:
      "Build identifier to attach, such as a CI run number. Links to the dashboard build when it matches one.",
  },
  url: {
    type: "string",
    format: "uri",
    maxLength: 2000,
    description: "http(s) link to attach, such as the CI run.",
  },
  projectName: {
    type: "string",
    maxLength: 200,
    description: "Project the dSYMs belong to.",
  },
} as const;

const dsymUploadResponse = {
  type: "object",
  required: ["upload", "dsyms", "duplicate"],
  properties: {
    duplicate: {
      type: "boolean",
      description:
        "True when the same zip was already uploaded; the existing upload is returned.",
    },
    upload: {
      type: "object",
      required: ["id", "status"],
      properties: {
        id: { type: "string", format: "uuid" },
        status: { type: "string", enum: ["READY"] },
        ...metadataFields,
      },
    },
    dsyms: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "bundleName", "slices", "url"],
        properties: {
          id: { type: "string", format: "uuid" },
          bundleName: { type: "string" },
          version: { type: ["string", "null"] },
          build: { type: ["string", "null"] },
          url: { type: "string" },
          slices: {
            type: "array",
            items: {
              type: "object",
              required: ["uuid", "arch"],
              properties: {
                uuid: {
                  type: "string",
                  example: "776386D0-4386-3F24-9B21-5F7C02EB2873",
                },
                arch: { type: "string", example: "arm64" },
              },
            },
          },
        },
      },
    },
  },
} as const;

const dsymSecurity = [
  { ApiKey: [] },
  { BetterAuthCookie: [] },
  { BetterAuthBearer: [] },
] as const;

const errors = {
  "400": {
    description: "The request or zip is invalid",
    content: { "application/json": { schema: errorResponse } },
  },
  "401": {
    description: "An API key or user session is required",
    content: { "application/json": { schema: errorResponse } },
  },
  "413": {
    description: "The upload exceeds its size limit",
    content: { "application/json": { schema: errorResponse } },
  },
} as const;

export const crashesOpenApiDocument = {
  tags: [{ name: "Crashes" }],
  paths: {
    "/api/crashes": {
      post: {
        tags: ["Crashes"],
        summary: "Upload a crash report",
        description:
          "Accepts one `.ips` report, `.crash` text report, or MetricKit `MXDiagnosticPayload` / `MXCrashDiagnostic` JSON as the raw request body, capped at 5 MiB after optional gzip decoding. Unauthenticated so shipped apps can report; `X-API-Key` is optional and records which key sent the report. A MetricKit payload with several diagnostics creates one crash per diagnostic. Re-sending the same bytes returns the existing crashes.",
        security: [{}, { ApiKey: [] }],
        parameters: [
          {
            name: "X-Crash-Filename",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 255 },
            description: "File name to show in the dashboard.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "string",
                description: ".ips report or MetricKit JSON",
              },
            },
            "text/plain": {
              schema: { type: "string", description: ".crash report" },
            },
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "201": {
            description: "Crash reports stored and queued for symbolication",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["crashes"],
                  properties: {
                    crashes: { type: "array", items: crashSummary },
                  },
                },
              },
            },
          },
          "200": {
            description: "The same report was already uploaded",
          },
          "202": {
            description: "Crash collection is turned off; nothing was stored",
          },
          "401": errors["401"],
          "413": errors["413"],
          "415": {
            description: "The body is not a recognized crash report format",
            content: { "application/json": { schema: errorResponse } },
          },
          "422": {
            description:
              "The report is not a crash (for example an .ips hang report) or has no stacks",
            content: { "application/json": { schema: errorResponse } },
          },
          "429": {
            description: "Too many reports from this address; retry later",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
    },
    "/api/dsyms": {
      post: {
        tags: ["Crashes"],
        summary: "Upload dSYMs",
        description:
          "Uploads a zip of one or more `.dSYM` bundles, such as an archive's `dSYMs` folder or fastlane's `.app.dSYM.zip`, in one request. Send `multipart/form-data` with a `file` part, or a raw `application/zip` body with the metadata as query parameters. Limited to `DSYM_UPLOAD_MAX_BYTES` (2 GiB by default); use the resumable endpoints for larger zips or behind proxies with request size limits. Crashes waiting on the uploaded UUIDs are symbolicated again automatically.",
        security: dsymSecurity,
        parameters: Object.entries(metadataFields).map(([name, schema]) => ({
          name,
          in: "query",
          required: false,
          schema,
          description: `${schema.description} Only read for raw zip bodies.`,
        })),
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary" },
                  ...metadataFields,
                },
              },
            },
            "application/zip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "201": {
            description: "dSYMs indexed",
            content: { "application/json": { schema: dsymUploadResponse } },
          },
          "200": {
            description: "The zip was already uploaded",
            content: { "application/json": { schema: dsymUploadResponse } },
          },
          ...errors,
        },
      },
    },
    "/api/dsyms/uploads": {
      post: {
        tags: ["Crashes"],
        summary: "Start a resumable dSYM upload",
        description:
          "Declares a zip's size and, optionally, its sha256. Send the bytes with `PATCH /api/dsyms/uploads/{id}` in chunks of at most `chunkBytes`, then call `/complete`.",
        security: dsymSecurity,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["filename", "sizeBytes"],
                properties: {
                  filename: { type: "string", maxLength: 255 },
                  sizeBytes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 21474836480,
                  },
                  sha256: {
                    type: "string",
                    pattern: "^[0-9a-f]{64}$",
                    description:
                      "Optional digest of the whole zip, checked on completion.",
                  },
                  ...metadataFields,
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Upload started",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "uploadOffset", "chunkBytes"],
                  properties: {
                    id: { type: "string", format: "uuid" },
                    uploadOffset: { type: "integer" },
                    chunkBytes: { type: "integer", example: 16777216 },
                  },
                },
              },
            },
          },
          ...errors,
        },
      },
    },
    "/api/dsyms/uploads/{id}": {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      head: {
        tags: ["Crashes"],
        summary: "Read a resumable upload's offset",
        description:
          "Returns the bytes received so far in `Upload-Offset`, so an interrupted upload resumes from there.",
        security: dsymSecurity,
        responses: {
          "204": {
            description: "Offset returned in headers",
            headers: {
              "Upload-Offset": { schema: { type: "integer" } },
              "Upload-Length": { schema: { type: "integer" } },
            },
          },
          "404": { description: "No such upload" },
        },
      },
      patch: {
        tags: ["Crashes"],
        summary: "Append a chunk",
        description:
          "Appends 1 byte to 16 MiB at `Upload-Offset`, which must equal the bytes already received.",
        security: dsymSecurity,
        parameters: [
          {
            name: "Upload-Offset",
            in: "header",
            required: true,
            schema: { type: "integer" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/offset+octet-stream": {
              schema: { type: "string", format: "binary" },
            },
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        responses: {
          "204": {
            description: "Chunk stored",
            headers: { "Upload-Offset": { schema: { type: "integer" } } },
          },
          "409": {
            description: "The offset does not match the bytes received",
            content: { "application/json": { schema: errorResponse } },
          },
          ...errors,
        },
      },
    },
    "/api/dsyms/uploads/{id}/complete": {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      post: {
        tags: ["Crashes"],
        summary: "Finish a resumable upload",
        description:
          "Verifies the sha256 and indexes the zip. Returns the same body as `POST /api/dsyms`.",
        security: dsymSecurity,
        responses: {
          "201": {
            description: "dSYMs indexed",
            content: { "application/json": { schema: dsymUploadResponse } },
          },
          "409": {
            description: "Not every byte has been received",
            content: { "application/json": { schema: errorResponse } },
          },
          "422": {
            description: "The bytes do not match the declared sha256",
            content: { "application/json": { schema: errorResponse } },
          },
          ...errors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKey: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description:
          "API key from the API Keys page (`aide_…`). Store it as a CI secret.",
      },
    },
  },
} as const;
