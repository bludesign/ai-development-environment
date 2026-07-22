import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { verifyArtifactToken } from "@/lib/artifact-token";
import { parseRangeHeader } from "@/lib/http-range";
import { materializeArtifact } from "@/services/builds/artifact-cache";

export const runtime = "nodejs";
export const maxDuration = 1800;

function disposition(filename: string): string {
  const safe = filename.replace(/["\r\n]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) {
    return new Response("Artifact not found", { status: 404 });
  }
  if (/offline|unavailable|must be updated/i.test(message)) {
    return new Response(message, { status: 409 });
  }
  console.error("Build artifact download failed:", error);
  return new Response("Could not download artifact", { status: 500 });
}

async function respond(
  request: Request,
  context: { params: Promise<{ buildId: string; artifactId: string }> },
  includeBody: boolean,
): Promise<Response> {
  try {
    const { buildId, artifactId } = await context.params;
    // A token is only rejected when one is supplied: install manifests mint
    // expiring links, while the plain links in the UI carry none and still work.
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (
      token &&
      !verifyArtifactToken(artifactId, token, url.searchParams.get("expires"))
    ) {
      return new Response("This download link has expired", { status: 403 });
    }
    const artifact = await materializeArtifact(buildId, artifactId);
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": disposition(artifact.filename),
      "content-type": artifact.contentType,
      etag: artifact.etag,
    };

    const range = parseRangeHeader(request.headers.get("range"), artifact.size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${artifact.size}` },
      });
    }

    if (range) {
      const length = range.end - range.start + 1;
      return new Response(
        includeBody
          ? (Readable.toWeb(
              createReadStream(artifact.path, {
                start: range.start,
                end: range.end,
              }),
            ) as ReadableStream)
          : null,
        {
          status: 206,
          headers: {
            ...headers,
            "content-length": String(length),
            "content-range": `bytes ${range.start}-${range.end}/${artifact.size}`,
          },
        },
      );
    }

    return new Response(
      includeBody
        ? (Readable.toWeb(createReadStream(artifact.path)) as ReadableStream)
        : null,
      {
        status: 200,
        headers: { ...headers, "content-length": String(artifact.size) },
      },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ buildId: string; artifactId: string }> },
): Promise<Response> {
  return respond(request, context, true);
}

/**
 * Declared explicitly rather than left to the framework: the install button
 * warms the cache with a HEAD before handing off to iOS, and the install daemon
 * probes the package the same way before it starts downloading.
 */
export async function HEAD(
  request: Request,
  context: { params: Promise<{ buildId: string; artifactId: string }> },
): Promise<Response> {
  return respond(request, context, false);
}
