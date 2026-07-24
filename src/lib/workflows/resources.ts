export function pullRequestResourceId(
  owner: string,
  repository: string,
  number: number,
): string {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedRepository = repository.trim().toLowerCase();
  if (!normalizedOwner || !normalizedRepository) {
    throw new Error("Pull request repository coordinates are required");
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("Pull request number must be a positive integer");
  }
  return `${normalizedOwner}/${normalizedRepository}#${number}`;
}
