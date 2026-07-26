import * as z from "zod/v4";

import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  type BuiltInToolDefinition,
  type ToolAnnotations,
} from "../builtin-tools";

type ServiceToolInput<I extends z.ZodType> = {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  service: unknown;
  method: string;
  arguments?: (value: z.output<I>) => unknown[];
  resultKey?: string;
  annotations?: ToolAnnotations;
  mapResult?: (value: unknown) => unknown;
};

export async function invokeService(
  service: unknown,
  method: string,
  args: unknown[] = [],
): Promise<unknown> {
  if (!service || typeof service !== "object") {
    throw new Error(`Service for ${method} is unavailable`);
  }
  const candidate = (service as Record<string, unknown>)[method];
  if (typeof candidate !== "function") {
    throw new Error(`Service operation ${method} is unavailable`);
  }
  return Reflect.apply(candidate, service, args) as Promise<unknown>;
}

const FORBIDDEN_OUTPUT_KEY =
  /^(?:credentialValue|enrollmentToken|privateKey|privateKeyPem|p12|p12Base64|apnsToken|token|nativeTranscript|nativeSession|nativeSessionFile|rawJson|secretHash|tokenHash)$/i;

export function redactSensitiveToolOutput(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redactSensitiveToolOutput);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FORBIDDEN_OUTPUT_KEY.test(key))
      .map(([key, child]) => [key, redactSensitiveToolOutput(child)]),
  );
}

export function serviceTool<I extends z.ZodType>(
  input: ServiceToolInput<I>,
): BuiltInToolDefinition {
  const resultKey = input.resultKey ?? "result";
  return defineTool({
    name: input.name,
    title: input.title,
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: z.object({ [resultKey]: z.unknown() }),
    annotations: input.annotations ?? READ_ONLY_ANNOTATIONS,
    handler: async (value) => {
      const result = await invokeService(
        input.service,
        input.method,
        input.arguments?.(value) ?? [value],
      );
      return {
        [resultKey]: input.mapResult
          ? input.mapResult(result)
          : redactSensitiveToolOutput(result ?? null),
      };
    },
  });
}

export const emptyInput = z.object({});
export const identifierInput = (name = "id") =>
  z.object({ [name]: z.string().min(1) });
