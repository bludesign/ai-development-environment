#!/usr/bin/env node
// Assembles the publishable @ai-development-environment/server package from the
// `.next/standalone` build output into `.npm-staging/server/`. Run `npm run build` first.
//
// Usage: node scripts/prepare-npm-server-package.mjs --version X.Y.Z
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function fail(message) {
  console.error(`prepare-npm-server-package: ${message}`);
  process.exit(1);
}

const versionFlagIndex = process.argv.indexOf("--version");
const version =
  versionFlagIndex === -1 ? undefined : process.argv[versionFlagIndex + 1];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail("required: --version X.Y.Z (optionally with a prerelease suffix)");
}

const standaloneSource = path.join(repoRoot, ".next", "standalone");
if (!existsSync(path.join(standaloneSource, "server.js"))) {
  fail(
    `no standalone build at ${standaloneSource}; run \`npm run build\` first`,
  );
}

const stagingDir = path.join(repoRoot, ".npm-staging", "server");
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

// Standalone tree, minus local environment files.
cpSync(standaloneSource, path.join(stagingDir, "standalone"), {
  recursive: true,
  filter: (source) => {
    const base = path.basename(source);
    return base !== ".DS_Store" && !base.startsWith(".env");
  },
});

// Native modules are platform-specific; drop the traced copies and install them as real
// dependencies instead so npm builds the correct platform binary at install time.
const nativeModules = ["better-sqlite3", "sharp", "@img", "@napi-rs/keyring"];
for (const name of nativeModules) {
  rmSync(path.join(stagingDir, "standalone", "node_modules", name), {
    recursive: true,
    force: true,
  });
}
const napiRsDirectory = path.join(
  stagingDir,
  "standalone",
  "node_modules",
  "@napi-rs",
);
if (existsSync(napiRsDirectory)) {
  for (const entry of readdirSync(napiRsDirectory)) {
    if (entry.startsWith("keyring-")) {
      rmSync(path.join(napiRsDirectory, entry), {
        recursive: true,
        force: true,
      });
    }
  }
}

// Turbopack aliases externalized packages behind hashed names (for example
// `better-sqlite3-90e2652d1716b047`) that are symlinks in `standalone/.next/node_modules`,
// and npm drops symlinks from tarballs. Replace every symlink with either a stub that
// re-exports the npm-installed copy (for externalized native modules) or a dereferenced
// copy of its target (for pure-JS packages such as @prisma/client, whose subpaths the
// build imports directly).
function findSymlinks(directory) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      matches.push(entryPath);
    } else if (entry.isDirectory()) {
      matches.push(...findSymlinks(entryPath));
    }
  }
  return matches;
}

for (const link of findSymlinks(stagingDir)) {
  const target = path.resolve(path.dirname(link), readlinkSync(link));
  const targetRelative = path.relative(stagingDir, target);
  const nodeModulesIndex = targetRelative.lastIndexOf("node_modules/");
  if (nodeModulesIndex === -1) {
    fail(`symlink ${link} points outside node_modules: ${target}`);
  }
  const segments = targetRelative
    .slice(nodeModulesIndex + "node_modules/".length)
    .split("/");
  const packageName = segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];

  rmSync(link);
  const externalized =
    nativeModules.includes(packageName) ||
    packageName.startsWith("@img/") ||
    packageName.startsWith("@napi-rs/keyring-");
  if (externalized) {
    mkdirSync(link, { recursive: true });
    writeFileSync(
      path.join(link, "package.json"),
      `${JSON.stringify({ name: packageName, main: "index.cjs" }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(link, "index.cjs"),
      `module.exports = require(${JSON.stringify(packageName)});\n`,
    );
  } else {
    if (!existsSync(target)) {
      fail(`symlink ${link} points to a missing target: ${target}`);
    }
    cpSync(target, link, { recursive: true, dereference: true });
  }
}

const remainingSymlinks = findSymlinks(stagingDir);
if (remainingSymlinks.length > 0) {
  fail(
    `symlinks would be dropped by npm pack:\n${remainingSymlinks.join("\n")}`,
  );
}

function findNativeBinaries(directory) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findNativeBinaries(entryPath));
    } else if (entry.name.endsWith(".node")) {
      matches.push(entryPath);
    }
  }
  return matches;
}

const nativeBinaries = findNativeBinaries(stagingDir);
if (nativeBinaries.length > 0) {
  fail(
    "platform-specific binaries would be published; externalize these packages like " +
      `better-sqlite3/sharp:\n${nativeBinaries.join("\n")}`,
  );
}

// Self-contained Prisma migration inputs, mirroring the Homebrew formula's prisma-runtime.
const prismaRuntime = path.join(stagingDir, "prisma-runtime");
mkdirSync(path.join(prismaRuntime, "prisma"), { recursive: true });
cpSync(
  path.join(repoRoot, "prisma", "schema.prisma"),
  path.join(prismaRuntime, "prisma", "schema.prisma"),
);
cpSync(
  path.join(repoRoot, "prisma", "migrations"),
  path.join(prismaRuntime, "prisma", "migrations"),
  { recursive: true },
);
cpSync(
  path.join(repoRoot, "scripts", "npm", "prisma.config.cjs"),
  path.join(prismaRuntime, "prisma.config.js"),
);

mkdirSync(path.join(stagingDir, "bin"));
cpSync(
  path.join(repoRoot, "scripts", "npm", "server-bin.cjs"),
  path.join(stagingDir, "bin", "ai-development-environment.js"),
);
cpSync(path.join(repoRoot, "LICENSE.md"), path.join(stagingDir, "LICENSE.md"));
cpSync(
  path.join(repoRoot, "scripts", "npm", "server-README.md"),
  path.join(stagingDir, "README.md"),
);

// Curated manifest; dependency pins come from the root package.json (and next's own sharp
// range) so they cannot drift from what the app was built against.
const rootPackage = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const nextPackage = JSON.parse(
  readFileSync(
    path.join(repoRoot, "node_modules", "next", "package.json"),
    "utf8",
  ),
);
const betterSqlite3Version = rootPackage.dependencies?.["better-sqlite3"];
const keyringVersion = rootPackage.dependencies?.["@napi-rs/keyring"];
const prismaVersion = rootPackage.devDependencies?.prisma;
const sharpVersion =
  nextPackage.optionalDependencies?.sharp ?? nextPackage.dependencies?.sharp;
if (
  !betterSqlite3Version ||
  !keyringVersion ||
  !prismaVersion ||
  !sharpVersion
) {
  fail(
    "unable to resolve @napi-rs/keyring, better-sqlite3, prisma, or sharp versions to pin",
  );
}

const manifest = {
  name: "@ai-development-environment/server",
  version,
  description:
    "AI-focused development environment (prebuilt Next.js standalone server)",
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/bludesign/ai-development-environment.git",
  },
  bin: { "ai-development-environment": "bin/ai-development-environment.js" },
  engines: rootPackage.engines,
  files: ["bin", "standalone", "prisma-runtime"],
  dependencies: {
    "@napi-rs/keyring": keyringVersion,
    "better-sqlite3": betterSqlite3Version,
    prisma: prismaVersion,
    sharp: sharpVersion,
  },
  publishConfig: { access: "public" },
};
writeFileSync(
  path.join(stagingDir, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(
  `Staged @ai-development-environment/server@${version} at ${stagingDir}`,
);
