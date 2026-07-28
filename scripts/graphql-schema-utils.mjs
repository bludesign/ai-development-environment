import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

// Apollo loads GraphQL through CommonJS. Resolve both packages through the same loader so
// schema instances are never split across two module realms (notably under Vitest).
const require = createRequire(import.meta.url);
const { buildSubgraphSchema } = require("@apollo/subgraph");
const { Kind, parse, printSchema } = require("graphql");

const DESCRIBABLE_DEFINITION_KINDS = new Set([
  Kind.SCHEMA_DEFINITION,
  Kind.SCALAR_TYPE_DEFINITION,
  Kind.OBJECT_TYPE_DEFINITION,
  Kind.INTERFACE_TYPE_DEFINITION,
  Kind.UNION_TYPE_DEFINITION,
  Kind.ENUM_TYPE_DEFINITION,
  Kind.INPUT_OBJECT_TYPE_DEFINITION,
  Kind.DIRECTIVE_DEFINITION,
]);

export async function collectGraphQLFiles(rootDirectory) {
  const files = [];

  async function collect(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await collect(absolutePath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".graphql")) {
        files.push({
          absolutePath,
          relativePath,
          source: await readFile(absolutePath, "utf8"),
        });
      }
    }
  }

  await collect(rootDirectory);
  return files;
}

export async function generateRuntimeSchema(rootDirectory) {
  const files = await collectGraphQLFiles(rootDirectory);
  const typeDefs = files.map(({ source }) => parse(source));
  const schema = buildSubgraphSchema({ typeDefs });
  return `${printSchema(schema).trimEnd()}\n`;
}

function sourceLine(node) {
  return node.loc?.startToken.line ?? 1;
}

function missingDescription(file, node, path, kind) {
  return {
    file,
    line: sourceLine(node),
    path,
    kind,
  };
}

/**
 * Finds SDL nodes whose descriptions are exposed through GraphQL introspection but are
 * missing from the source. Type extensions themselves cannot have descriptions, while
 * the fields and arguments declared inside them can and are checked below.
 */
export function findUndocumentedSchemaElements(
  source,
  file = "schema.graphql",
) {
  const document = parse(source);
  const missing = [];

  for (const definition of document.definitions) {
    const definitionName = definition.name?.value ?? "schema";
    if (
      DESCRIBABLE_DEFINITION_KINDS.has(definition.kind) &&
      !definition.description
    ) {
      missing.push(
        missingDescription(file, definition, definitionName, "definition"),
      );
    }

    for (const field of definition.fields ?? []) {
      const fieldPath = `${definitionName}.${field.name.value}`;
      if (!field.description) {
        missing.push(missingDescription(file, field, fieldPath, "field"));
      }

      for (const argument of field.arguments ?? []) {
        if (!argument.description) {
          missing.push(
            missingDescription(
              file,
              argument,
              `${fieldPath}(${argument.name.value})`,
              "argument",
            ),
          );
        }
      }
    }

    for (const argument of definition.arguments ?? []) {
      if (!argument.description) {
        missing.push(
          missingDescription(
            file,
            argument,
            `@${definitionName}(${argument.name.value})`,
            "argument",
          ),
        );
      }
    }

    for (const value of definition.values ?? []) {
      if (!value.description) {
        missing.push(
          missingDescription(
            file,
            value,
            `${definitionName}.${value.name.value}`,
            "enum value",
          ),
        );
      }
    }
  }

  return missing;
}

export function formatUndocumentedSchemaElements(elements) {
  return elements
    .map(
      ({ file, line, path, kind }) =>
        `${file}:${line} ${path} is missing a ${kind} description`,
    )
    .join("\n");
}
