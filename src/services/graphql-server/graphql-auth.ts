import { Kind, parse } from "graphql";

export function isAnonymousAgentEnrollment(query: unknown): boolean {
  if (typeof query !== "string") return false;
  try {
    const document = parse(query);
    if (document.definitions.length !== 1) return false;
    const operation = document.definitions[0];
    if (
      operation?.kind !== Kind.OPERATION_DEFINITION ||
      operation.operation !== "mutation" ||
      operation.selectionSet.selections.length !== 1
    ) {
      return false;
    }
    const selection = operation.selectionSet.selections[0];
    return (
      !operation.directives?.length &&
      selection?.kind === Kind.FIELD &&
      !selection.alias &&
      !selection.directives?.length &&
      selection.name.value === "enrollAgent"
    );
  } catch {
    return false;
  }
}
