ALTER TABLE "Codebase" ADD COLUMN "localBranchesJson" TEXT NOT NULL DEFAULT '[]';

ALTER TABLE "JiraProject" ADD COLUMN "branchNamingScript" TEXT;

UPDATE "JiraProject"
SET "branchNamingScript" = 'function ({ ticketKey, type, title, alreadyTaken }) {
  const prefix = String(type).trim().toLowerCase() === "bug" ? "bugfix" : "feature";
  const slug = String(title).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `${prefix}/${ticketKey}${slug ? `-${slug}` : ""}`;
  if (!alreadyTaken) return base;
  const suffix = Number(String(alreadyTaken).slice(base.length + 1));
  return `${base}-${Number.isInteger(suffix) && suffix >= 2 ? suffix + 1 : 2}`;
}';
