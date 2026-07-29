import type { Page } from "@playwright/test";

import { CHANGED_COVERAGE_FILES } from "../scripts/mock-data/coverage";

/**
 * Answers the two worktree inspection mutations for a capture.
 *
 * Everything else a screenshot needs is in the mock database or the stubbed GitHub/Jira API,
 * but a worktree diff is not stored anywhere: `inspectWorktree` and `inspectWorktreeDiff`
 * queue a job for the Mac that owns the checkout and wait up to 30s for it to answer. No agent
 * is connected during a capture, so the changes page would otherwise be photographed on its
 * spinner. This intercepts those two operations at the GraphQL endpoint and replies with a
 * branch diff built from the same coverage fixture the seeded report describes, which is what
 * makes the coverage overlay land on real lines.
 *
 * Every other operation falls through to the real server.
 */

const FILES = CHANGED_COVERAGE_FILES.map((file) => ({
  path: file.path,
  previousPath: null,
  changeType: file.changeType === "ADDED" ? "A" : "M",
  additions: file.changedExecutableLines,
  deletions:
    file.changeType === "ADDED"
      ? 0
      : Math.round(file.changedExecutableLines * 0.4),
  binary: false,
  image: false,
}));

/** Working-tree changes, so the Staged and Unstaged scopes are not empty either. */
const WORKING_CHANGES = [
  {
    path: "AcmeApp/Search/SearchCoordinator.swift",
    previousPath: null,
    changeType: "M",
    staged: true,
    unstaged: false,
    untracked: false,
    conflicted: false,
    stagedAdditions: 18,
    stagedDeletions: 6,
    unstagedAdditions: 0,
    unstagedDeletions: 0,
  },
  {
    path: "AcmeKit/Auth/DeviceAuthorizationClient.swift",
    previousPath: null,
    changeType: "M",
    staged: false,
    unstaged: true,
    untracked: false,
    conflicted: false,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedAdditions: 24,
    unstagedDeletions: 4,
  },
  {
    path: "AcmeAppTests/Search/SearchCoordinatorTests.swift",
    previousPath: null,
    changeType: "A",
    staged: false,
    unstaged: false,
    untracked: true,
    conflicted: false,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedAdditions: 0,
    unstagedDeletions: 0,
  },
];

const COMMITS = [
  {
    sha: "9d41f0a7c2e5b8134a6d7f90e1c2b3a45d6e7f80",
    subject: "Add device authorization polling to the auth client",
    authorName: "Dana Alvarez",
    authoredAt: "2026-07-27T16:42:11.000Z",
    additions: 214,
    deletions: 38,
  },
  {
    sha: "5c7e2b90a1d4f6832b5c8e0d7a9f1b3c4d5e6f70",
    subject: "Debounce the search coordinator's query stream",
    authorName: "Dana Alvarez",
    authoredAt: "2026-07-27T11:08:53.000Z",
    additions: 96,
    deletions: 41,
  },
  {
    sha: "3b6a1d58e0c9f2748d1e5b7a0c3f6d92e4a7b8c1",
    subject: "Persist recent searches between launches",
    authorName: "Priya Nair",
    authoredAt: "2026-07-26T19:31:07.000Z",
    additions: 71,
    deletions: 0,
  },
];

/** `SearchCoordinator.swift` -> `SearchCoordinator`. */
function typeName(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.swift$/, "");
}

/**
 * Renders one hunk, counting its own old and new line totals. Hand-written `@@` headers whose
 * counts disagree with the body parse to nothing, and the diff pane reports the file as having
 * no textual changes.
 */
function hunk(
  oldStart: number,
  newStart: number,
  section: string,
  lines: string[],
): string[] {
  const oldLines = lines.filter((line) => !line.startsWith("+")).length;
  const newLines = lines.filter((line) => !line.startsWith("-")).length;
  return [
    `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@ ${section}`,
    ...lines,
  ];
}

/**
 * A believable Swift diff for one file, at line numbers the coverage fixture also has
 * executable lines at, so the overlay marks the hunk rather than leaving it blank.
 */
function patchFor(path: string, changeType: string): string {
  const name = typeName(path);
  const header = `diff --git a/${path} b/${path}`;
  if (changeType === "A") {
    const body = [
      "import Foundation",
      "",
      `/// Coordinates the ${name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}.`,
      `final class ${name} {`,
      "    private let session: URLSession",
      "    private let decoder: JSONDecoder",
      "",
      "    init(session: URLSession = .shared) {",
      "        self.session = session",
      "        self.decoder = JSONDecoder()",
      "    }",
      "",
      "    func load(from url: URL) async throws -> Response {",
      "        let (data, response) = try await session.data(from: url)",
      "        guard let http = response as? HTTPURLResponse else {",
      "            throw ClientError.malformedResponse",
      "        }",
      "        guard (200..<300).contains(http.statusCode) else {",
      "            throw ClientError.status(http.statusCode)",
      "        }",
      "        return try decoder.decode(Response.self, from: data)",
      "    }",
      "}",
    ];
    return [
      header,
      "new file mode 100644",
      "index 0000000..7f3a1c9",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${body.length} @@`,
      ...body.map((line) => `+${line}`),
      "",
    ].join("\n");
  }
  return [
    header,
    "index 4b7e8d0..9f3c1a2 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunk(38, 38, `extension ${name} {`, [
      `     private func makeRequest(for query: String) -> URLRequest {`,
      `         var request = URLRequest(url: endpoint)`,
      `         request.httpMethod = "POST"`,
      `-        request.timeoutInterval = 30`,
      `+        request.timeoutInterval = configuration.timeout`,
      `+        request.cachePolicy = .reloadRevalidatingCacheData`,
      `         request.setValue("application/json", forHTTPHeaderField: "Content-Type")`,
      `         return request`,
      `     }`,
      ` `,
      `-    private func decode(_ data: Data) throws -> Payload {`,
      `-        try JSONDecoder().decode(Payload.self, from: data)`,
      `+    private func decode(_ data: Data) throws -> Payload {`,
      `+        guard !data.isEmpty else { throw ClientError.emptyPayload }`,
      `+        return try decoder.decode(Payload.self, from: data)`,
      `     }`,
      ` }`,
    ]),
    ...hunk(74, 76, `extension ${name} {`, [
      `     func refresh(force: Bool = false) async {`,
      `         guard force || isStale else { return }`,
      `-        state = .loading`,
      `+        state = .loading(startedAt: clock.now)`,
      `         do {`,
      `             let payload = try await load()`,
      `-            state = .loaded(payload)`,
      `+            state = .loaded(payload, at: clock.now)`,
      `+            analytics.record(.refreshed(count: payload.items.count))`,
      `         } catch {`,
      `             state = .failed(error)`,
      `+            analytics.record(.refreshFailed(reason: String(describing: error)))`,
      `         }`,
      `     }`,
      ` }`,
    ]),
    "",
  ].join("\n");
}

type GraphQLBody = {
  query?: string;
  variables?: {
    input?: { path?: string | null; scope?: string };
  };
};

/**
 * Intercepts the control-plane GraphQL endpoint for the page and answers the worktree
 * inspection mutations. Install it before navigating.
 */
export async function stubWorktreeAgent(page: Page): Promise<void> {
  await page.route("**/api/graphql", async (route) => {
    let body: GraphQLBody = {};
    try {
      body = (route.request().postDataJSON() ?? {}) as GraphQLBody;
    } catch {
      // A request without a JSON body is never one of ours.
    }
    const query = body.query ?? "";
    const respond = (data: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data }),
      });

    if (query.includes("inspectWorktree(")) {
      return respond({
        inspectWorktree: {
          commits: COMMITS,
          changes: WORKING_CHANGES,
          branchChanges: FILES,
          commitsTruncated: false,
          changesTruncated: false,
          branchChangesTruncated: false,
        },
      });
    }

    if (query.includes("inspectWorktreeDiff(")) {
      const path = body.variables?.input?.path ?? null;
      const file = FILES.find((entry) => entry.path === path) ?? FILES[0]!;
      return respond({
        inspectWorktreeDiff: {
          // Only the per-commit scope asks for a file list; the page ignores it otherwise.
          files: FILES,
          patch: patchFor(file.path, file.changeType),
          image: false,
          binary: false,
          truncated: false,
          beforeAvailable: false,
          afterAvailable: false,
        },
      });
    }

    return route.continue();
  });
}
