import Ajv, { type AnySchema, type Options } from "ajv";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

type Dialect = "draft7" | "2019" | "2020";

const canonicalUris: Record<Dialect, string> = {
  draft7: "http://json-schema.org/draft-07/schema#",
  "2019": "https://json-schema.org/draft/2019-09/schema",
  "2020": "https://json-schema.org/draft/2020-12/schema",
};

function dialectFor(uri: unknown, fallback: Dialect): Dialect {
  if (uri === undefined) return fallback;
  if (typeof uri !== "string")
    throw new Error("JSON Schema dialect must be a URI");
  const normalized = uri.replace(/^http:/, "https:").replace(/#$/, "");
  for (const [dialect, canonical] of Object.entries(canonicalUris)) {
    if (normalized === canonical.replace(/^http:/, "https:").replace(/#$/, ""))
      return dialect as Dialect;
  }
  throw new Error(`Unsupported JSON Schema dialect: ${uri}`);
}

/** Inspect schema locations only: examples/defaults may contain arbitrary data. */
function assertSynchronousDialect(schema: unknown, dialect: Dialect): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const object = schema as Record<string, unknown>;
  if (object.$async !== undefined)
    throw new Error("Asynchronous JSON Schema validation is not supported");
  if (dialectFor(object.$schema, dialect) !== dialect)
    throw new Error("Mixed JSON Schema dialects are not supported");

  for (const keyword of [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
    "dependencies",
  ]) {
    const map = object[keyword];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const child of Object.values(map))
        assertSynchronousDialect(child, dialect);
    }
  }
  for (const keyword of [
    "additionalProperties",
    "unevaluatedProperties",
    "propertyNames",
    "additionalItems",
    "unevaluatedItems",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ])
    assertSynchronousDialect(object[keyword], dialect);
  for (const keyword of ["items", "prefixItems", "allOf", "anyOf", "oneOf"]) {
    const value = object[keyword];
    if (Array.isArray(value)) {
      for (const child of value) assertSynchronousDialect(child, dialect);
    } else assertSynchronousDialect(value, dialect);
  }
}

/** Compile one frozen tool schema without silently discarding newer constraints. */
export function compileMcpJsonSchema(
  schema: Record<string, unknown>,
): (value: unknown) => { valid: boolean; errorMessage?: string } {
  const dialect = dialectFor(schema.$schema, "2020");
  assertSynchronousDialect(schema, dialect);
  const options: Options = {
    strict: false,
    strictSchema: true,
    strictNumbers: true,
    validateSchema: true,
    validateFormats: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  };
  const ajv =
    dialect === "draft7"
      ? new Ajv(options)
      : dialect === "2019"
        ? new Ajv2019(options)
        : new Ajv2020(options);
  addFormats(ajv);
  // Keep each input/output in its own registry, even if upstream reuses $id.
  const validate = ajv.compile({
    ...schema,
    $schema: canonicalUris[dialect],
  } as AnySchema);
  if ("$async" in validate && validate.$async)
    throw new Error("Asynchronous JSON Schema validation is not supported");
  return (value) => {
    const valid = validate(value) === true;
    return valid
      ? { valid }
      : { valid, errorMessage: ajv.errorsText(validate.errors) };
  };
}
