// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { thinMachO } from "@/services/crashes/__fixtures__/macho-builder";
import { extractDsymArchive } from "@/services/crashes/dsym-index";

import { crashApiDocumentation, DSYM_UPLOAD_SCRIPT } from "./api-docs";
import {
  crashContentType,
  dsymZipEntries,
  uploadDsymZip,
  zipDsymBundles,
} from "./uploads";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

function file(bytes: Buffer | string, name: string) {
  return new File(
    [typeof bytes === "string" ? bytes : new Uint8Array(bytes)],
    name,
  );
}

describe("crash upload helpers", () => {
  test("labels crash files by extension", () => {
    expect(crashContentType("App.ips")).toBe("application/json");
    expect(crashContentType("payload.JSON")).toBe("application/json");
    expect(crashContentType("App.crash")).toBe("text/plain");
    expect(crashContentType("report")).toBe("application/octet-stream");
  });

  test("keeps only dSYM bundles of a dropped archive, named from the bundle", () => {
    const dwarf = file("x", "App");
    expect(
      dsymZipEntries([
        {
          file: dwarf,
          path: "App.xcarchive/dSYMs/App.app.dSYM/Contents/Resources/DWARF/App",
        },
        { file: file("x", "Info.plist"), path: "App.xcarchive/Info.plist" },
        {
          file: file("x", "._App"),
          path: "App.xcarchive/dSYMs/App.app.dSYM/Contents/Resources/DWARF/._App",
        },
        {
          file: file("x", "App"),
          path: "App.xcarchive/Products/Applications/App.app/App",
        },
      ]),
    ).toEqual([
      { name: "App.app.dSYM/Contents/Resources/DWARF/App", file: dwarf },
    ]);
  });

  test("zips dropped bundles into an archive the server can index", async () => {
    const progress: number[] = [];
    const blob = await zipDsymBundles(
      [
        {
          name: "App.app.dSYM/Contents/Resources/DWARF/App",
          file: file(
            thinMachO({ uuid: "11111111222233334444555555555555" }),
            "App",
          ),
        },
      ],
      (value) => progress.push(value),
    );
    expect(progress.at(-1)).toBe(1);
    const directory = await mkdtemp(join(tmpdir(), "browser-zip-"));
    directories.push(directory);
    const zipPath = join(directory, "dSYMs.zip");
    await writeFile(zipPath, Buffer.from(await blob.arrayBuffer()));
    const [dsym] = await extractDsymArchive({
      zipPath,
      archiveName: "dSYMs.zip",
      destination: join(directory, "out"),
    });
    expect(dsym).toMatchObject({
      bundleName: "App.app.dSYM",
      slices: [{ uuid: "11111111222233334444555555555555", arch: "arm64" }],
    });
  });

  test("uploads in chunks and resumes from the server's offset", async () => {
    const calls: { method: string; offset: string | null; size: number }[] = [];
    let received = 0;
    let conflictSent = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const method = init.method ?? "GET";
        const headers = new Headers(init.headers);
        const body = init.body instanceof Blob ? init.body.size : 0;
        calls.push({
          method,
          offset: headers.get("upload-offset"),
          size: body,
        });
        if (url === "/api/dsyms/uploads") {
          return Response.json({ id: "upload-1" }, { status: 201 });
        }
        if (method === "PATCH") {
          // The first chunk lands but its response is lost, so the retry
          // conflicts and the client asks where to continue.
          if (!conflictSent && received === 0) {
            received += body;
            conflictSent = true;
            throw new Error("socket hang up");
          }
          if (Number(headers.get("upload-offset")) !== received) {
            return Response.json({}, { status: 409 });
          }
          received += body;
          return new Response(null, {
            status: 204,
            headers: { "upload-offset": String(received) },
          });
        }
        if (method === "HEAD") {
          return new Response(null, {
            status: 204,
            headers: { "upload-offset": String(received) },
          });
        }
        return Response.json({ duplicate: false, upload: {}, dsyms: [] });
      }),
    );
    const size = 16 * 1024 * 1024 + 10;
    const progress: number[] = [];
    await uploadDsymZip(
      new Blob([new Uint8Array(size)]),
      "dSYMs.zip",
      { projectName: "Demo" },
      { onProgress: (value) => progress.push(value) },
    );
    expect(received).toBe(size);
    expect(progress.at(-1)).toBe(1);
    expect(calls.at(-1)).toMatchObject({ method: "POST" });
    expect(calls.filter((call) => call.method === "HEAD")).toHaveLength(1);
  }, 20_000);

  test("documents every upload endpoint with the server's address", () => {
    const docs = crashApiDocumentation("https://aide.example.com");
    expect(docs).toContain("POST https://aide.example.com/api/public/crashes");
    expect(docs).toContain("'https://aide.example.com/api/dsyms'");
    expect(docs).toContain("${{ secrets.AIDE_API_KEY }}");
    expect(docs).toContain(
      "uses: bludesign/ai-development-environment-upload-dsyms@v1",
    );
    expect(docs).toContain("    url: https://aide.example.com\n");
    expect(docs).toContain(DSYM_UPLOAD_SCRIPT);
    expect(DSYM_UPLOAD_SCRIPT).toContain('"${PROJECT_NAME:-}"');
  });
});
