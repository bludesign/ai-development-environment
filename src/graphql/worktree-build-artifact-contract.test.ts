import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { buildSubgraphSchema } from "@apollo/subgraph";
import { expect, test } from "vitest";

import {
  WORKTREE_FIELDS,
  WORKTREE_LIST_FIELDS,
} from "@/components/worktrees/worktree-graphql";
import type {
  WorktreeAutomationService,
  WorktreesService,
} from "@/services/worktrees";
import { createWorktreeResolvers } from "./resolvers/worktrees";

const { concatAST, graphql, parse, validate } = createRequire(import.meta.url)(
  "graphql",
) as typeof import("graphql");

test("the worktree schema supports both web selections and returns latest build artifact metadata", async () => {
  const schemas = new URL("../../schemas/", import.meta.url);
  const resolvers = createWorktreeResolvers(
    {} as WorktreesService,
    {} as WorktreeAutomationService,
  );
  const schema = buildSubgraphSchema([
    {
      typeDefs: concatAST(
        readdirSync(schemas)
          .filter((name) => name.endsWith(".graphql"))
          .map((name) => parse(readFileSync(new URL(name, schemas), "utf8"))),
      ),
      resolvers: {
        WorktreeLatestBuildArtifact: resolvers.WorktreeLatestBuildArtifact,
      },
    },
  ]);

  for (const fields of [WORKTREE_FIELDS, WORKTREE_LIST_FIELDS]) {
    expect(
      validate(schema, parse(`{ hiddenWorktrees { ${fields} } }`)),
    ).toEqual([]);
  }

  const metadata = { signed: true, applicationId: "com.example.app" };
  const result = await graphql({
    schema,
    source: `{ hiddenWorktrees { latestBuild { artifacts { id kind checksum metadata } } } }`,
    rootValue: {
      hiddenWorktrees: [
        {
          latestBuild: {
            artifacts: [
              {
                id: "apk",
                kind: "APK",
                checksum: "sha256:artifact",
                metadataJson: JSON.stringify(metadata),
              },
              { id: "legacy", kind: "RUNNABLE_APP" },
              { id: "malformed", kind: "APK", metadataJson: "{" },
              { id: "null", kind: "APK", metadataJson: "null" },
            ],
          },
        },
      ],
    },
  });
  expect(result.errors).toBeUndefined();
  expect(result.data).toEqual({
    hiddenWorktrees: [
      {
        latestBuild: {
          artifacts: [
            { id: "apk", kind: "APK", checksum: "sha256:artifact", metadata },
            {
              id: "legacy",
              kind: "RUNNABLE_APP",
              checksum: null,
              metadata: {},
            },
            { id: "malformed", kind: "APK", checksum: null, metadata: {} },
            { id: "null", kind: "APK", checksum: null, metadata: {} },
          ],
        },
      },
    ],
  });
});
