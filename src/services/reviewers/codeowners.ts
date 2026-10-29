import { compileRe2 } from "@/lib/re2.server";

export type CodeownersProvider = "GITHUB" | "GITLAB";

export type CodeownersEntry = {
  provider: CodeownersProvider;
  pattern: string;
  section: string;
  owners: string[];
  approvalsRequired: number;
  optional: boolean;
  exclusion: boolean;
};

/** Keep escaped whitespace in paths while splitting CODEOWNERS fields. */
function fields(line: string): string[] {
  return line.match(/(?:\\.|[^\s])+/g) ?? [];
}

function owners(tokens: string[], provider: CodeownersProvider): string[] {
  const result: string[] = [];
  for (const token of tokens) {
    if (provider === "GITHUB" && token.startsWith("#")) break;
    if (/^@[^\s]+$/.test(token) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(token)) {
      result.push(token);
    }
  }
  return [...new Set(result)];
}

export function parseCodeowners(
  text: string,
  provider: CodeownersProvider,
): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];
  const sections = new Map<
    string,
    { defaults: string[]; optional: boolean; approvalsRequired: number }
  >();
  let section = provider === "GITLAB" ? "codeowners" : "";
  sections.set(section, {
    defaults: [],
    optional: false,
    approvalsRequired: 1,
  });
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (provider === "GITLAB") {
      const header = /^(\^)?\[([^\]]+)\](?:\[(\d+)\])?(?:\s+(.*))?$/.exec(line);
      if (header) {
        section = header[2].trim().toLowerCase();
        const previous = sections.get(section);
        const count = Number(header[3] ?? 1);
        const optional = Boolean(header[1]);
        sections.set(section, {
          defaults: owners(fields(header[4] ?? ""), provider),
          optional: previous ? previous.optional && optional : optional,
          approvalsRequired:
            Number.isSafeInteger(count) && count > 0 ? count : 1,
        });
        continue;
      }
      // Malformed headings are invalid entries, never ownership paths.
      if (line.startsWith("^[") || /^\[[^\]]*$/.test(line)) continue;
    }
    const tokens = fields(line);
    let pattern = tokens.shift() ?? "";
    if (!pattern || pattern.length > 1_024) continue;
    if (
      provider === "GITHUB" &&
      (pattern.startsWith("!") ||
        pattern.startsWith("\\#") ||
        /[\[\]]/.test(pattern))
    )
      continue;
    const exclusion = provider === "GITLAB" && pattern.startsWith("!");
    if (exclusion) pattern = pattern.slice(1);
    if (!pattern) continue;
    const options = sections.get(section)!;
    const explicit = owners(tokens, provider);
    entries.push({
      provider,
      pattern,
      section,
      owners: exclusion
        ? []
        : explicit.length
          ? explicit
          : [...options.defaults],
      approvalsRequired: options.approvalsRequired,
      optional: options.optional,
      exclusion,
    });
  }
  // Duplicate headings can turn an earlier optional section into a required one.
  return entries.map((entry) => ({
    ...entry,
    optional: sections.get(entry.section)?.optional ?? entry.optional,
  }));
}

/** CODEOWNERS patterns have no executable regular-expression syntax. */
const matchers = new Map<string, ReturnType<typeof compileRe2>>();

export function ownershipPathMatches(
  pattern: string,
  path: string,
  {
    characterClasses = false,
    relativePathsAnywhere = false,
  }: { characterClasses?: boolean; relativePathsAnywhere?: boolean } = {},
): boolean {
  const cacheKey = `${characterClasses}\0${relativePathsAnywhere}\0${pattern}`;
  const cached = matchers.get(cacheKey);
  if (cached) return cached.test(path.replace(/^\/+/, ""));
  let value = pattern;
  const anchored = value.startsWith("/");
  if (anchored) value = value.slice(1);
  const directory = value.endsWith("/");
  if (directory) value = value.slice(0, -1);
  if (!value) return false;
  const anywhere = !anchored && (relativePathsAnywhere || !value.includes("/"));
  let expression = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      expression += value[++index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") {
      if (value[index + 1] === "*") {
        index += 1;
        if (value[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (char === "?") expression += "[^/]";
    else if (char === "[" && characterClasses) {
      const end = value.indexOf("]", index + 1);
      if (end > index + 1) {
        let range = value.slice(index + 1, end);
        if (range.startsWith("!")) range = `^${range.slice(1)}`;
        expression += `[${range.replace(/\\/g, "\\\\")}]`;
        index = end;
      } else expression += "\\[";
    } else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  const matcher = compileRe2(
    `${anywhere ? "(?:^|/)" : "^"}${expression}${directory ? "/" : /[*?\[]/.test(value) ? "$" : "(?:/|$)"}`,
    { maxLength: 8_192, label: "CODEOWNERS path" },
  );
  if (matchers.size >= 1_024) matchers.delete(matchers.keys().next().value!);
  matchers.set(cacheKey, matcher);
  return matcher.test(path.replace(/^\/+/, ""));
}

export function applicableCodeowners(
  entries: CodeownersEntry[],
  paths: string[],
): CodeownersEntry[] {
  const selected = new Set<CodeownersEntry>();
  const sections = [...new Set(entries.map((entry) => entry.section))];
  for (const path of paths) {
    for (const section of sections) {
      let last: CodeownersEntry | undefined;
      let excluded = false;
      for (const entry of entries) {
        if (
          entry.section !== section ||
          !ownershipPathMatches(entry.pattern, path, {
            characterClasses: entry.provider === "GITLAB",
            relativePathsAnywhere: entry.provider === "GITLAB",
          })
        )
          continue;
        if (entry.exclusion) excluded = true;
        else if (!excluded) last = entry;
      }
      if (!excluded && last?.owners.length) selected.add(last);
    }
  }
  return [...selected];
}

/** GitHub ruleset required-reviewer paths allow ordered exclusions. */
export function reviewerRuleApplies(
  patterns: string[],
  paths: string[],
): boolean {
  return paths.some((path) => {
    let included = false;
    for (const pattern of patterns) {
      if (
        ownershipPathMatches(pattern.replace(/^!/, ""), path, {
          characterClasses: true,
        })
      ) {
        included = !pattern.startsWith("!");
      }
    }
    return included;
  });
}
