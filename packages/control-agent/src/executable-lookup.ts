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
// ENOENT. Search the usual install directories before giving up on a tool.
export function findExecutable(
  name: string,
  options: ExecutableLookupOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? `${name}.exe` : name;
  const directories = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    // Global npm installs land next to the node binary running this agent.
    options.nodeDirectory ?? dirname(process.execPath),
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
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
