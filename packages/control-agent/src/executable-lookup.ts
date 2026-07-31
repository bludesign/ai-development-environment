import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type ExecutableLookupOptions = {
  // Environment variable that pins an explicit path to the executable.
  overrideVariable?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  nodeDirectory?: string;
  isExecutable?: (path: string) => boolean;
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// launchd starts `brew services` agents with PATH=/usr/bin:/bin:/usr/sbin:/sbin,
// so Homebrew, npm, and bun installs are invisible to a bare spawn and fail with
// ENOENT. These are the directories developer tooling actually lands in.
export function toolDirectories(
  options: ExecutableLookupOptions = {},
): string[] {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    // Where the opencode.ai install script puts its binary.
    join(home, ".opencode", "bin"),
    // Global npm installs land next to the node binary running this agent.
    options.nodeDirectory ?? dirname(process.execPath),
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
  ];
}

export function findExecutable(
  name: string,
  options: ExecutableLookupOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? `${name}.exe` : name;
  const directories = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    ...toolDirectories(options),
  ];
  const override = options.overrideVariable
    ? env[options.overrideVariable]?.trim()
    : undefined;
  const candidates = [
    ...(override ? [override] : []),
    ...directories.map((directory) => join(directory, executable)),
  ];
  const canExecute = options.isExecutable ?? isExecutable;
  return [...new Set(candidates)].find(canExecute);
}

// Third-party SDKs spawn their own binaries by bare name — the OpenCode SDK
// runs `opencode serve` through cross-spawn — so those lookups can only be
// fixed by repairing the PATH every child inherits.
export function extendedPath(options: ExecutableLookupOptions = {}): string {
  const env = options.env ?? process.env;
  const existing = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const additions = toolDirectories(options).filter(
    (directory) => !existing.includes(directory),
  );
  return [...existing, ...additions].join(delimiter);
}

export function repairToolPath(options: ExecutableLookupOptions = {}): void {
  const env = options.env ?? process.env;
  env.PATH = extendedPath(options);
}

// Puts a resolved tool's own directory ahead of everything else so a bare-name
// spawn inside an SDK picks up the install the agent resolved.
export function prependPathDirectory(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const existing = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (existing[0] === directory) return;
  env.PATH = [
    directory,
    ...existing.filter((entry) => entry !== directory),
  ].join(delimiter);
}
