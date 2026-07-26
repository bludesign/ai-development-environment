import "server-only";

import { Kind, parse, print, type DocumentNode } from "graphql";

const RATE_LIMIT_ALIAS = "_adeRateLimit";

export type PreparedGitHubGraphql = {
  kind: "query" | "mutation";
  operation: string;
  normalizedQuery: string;
  liveQuery: string;
};

export function prepareGitHubGraphql(query: string): PreparedGitHubGraphql {
  const document = parse(query);
  const operations = document.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operations.length !== 1 || !operations[0]) {
    throw new Error("GitHub GraphQL requests must contain one operation");
  }
  const operation = operations[0];
  const name =
    operation.name?.value ??
    (operation.operation === "mutation"
      ? "AnonymousMutation"
      : "AnonymousQuery");
  const normalizedQuery = print(document);
  if (operation.operation !== "query") {
    return {
      kind: "mutation",
      operation: name,
      normalizedQuery,
      liveQuery: normalizedQuery,
    };
  }
  const instrumented: DocumentNode = {
    ...document,
    definitions: document.definitions.map((definition) =>
      definition === operation
        ? {
            ...operation,
            selectionSet: {
              ...operation.selectionSet,
              selections: [
                ...operation.selectionSet.selections,
                {
                  kind: Kind.FIELD,
                  alias: { kind: Kind.NAME, value: RATE_LIMIT_ALIAS },
                  name: { kind: Kind.NAME, value: "rateLimit" },
                  arguments: [],
                  directives: [],
                  selectionSet: {
                    kind: Kind.SELECTION_SET,
                    selections: [
                      {
                        kind: Kind.FIELD,
                        name: { kind: Kind.NAME, value: "cost" },
                        arguments: [],
                        directives: [],
                      },
                    ],
                  },
                },
              ],
            },
          }
        : definition,
    ),
  };
  return {
    kind: "query",
    operation: name,
    normalizedQuery,
    liveQuery: print(instrumented),
  };
}

export function extractGitHubGraphqlCost<T>(data: T): {
  data: T;
  pointCost: number | null;
} {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { data, pointCost: null };
  }
  const record = data as Record<string, unknown>;
  const metadata = record[RATE_LIMIT_ALIAS];
  const cost =
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Number.isSafeInteger((metadata as Record<string, unknown>).cost)
      ? ((metadata as Record<string, unknown>).cost as number)
      : null;
  if (!(RATE_LIMIT_ALIAS in record)) return { data, pointCost: cost };
  const rest = { ...record };
  delete rest[RATE_LIMIT_ALIAS];
  return { data: rest as T, pointCost: cost };
}
