import "server-only";

import { Buffer } from "node:buffer";

import { getServerServices } from "@/services/server-services";

const PAGE_SIZE = 5_000;

function concatenateBase64(chunks: Array<{ dataBase64: string }>): Uint8Array {
  const output = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
  return new Uint8Array(output);
}

export async function commandRunRawOutput(
  runId: string,
): Promise<Uint8Array | null> {
  const { commandsService } = getServerServices();
  if (!(await commandsService.getRun(runId))) return null;

  const chunks: Array<{ dataBase64: string }> = [];
  let afterAttempt = 0;
  let afterSequence = -1;
  while (true) {
    const page = await commandsService.listOutput(
      runId,
      afterAttempt,
      afterSequence,
      PAGE_SIZE,
    );
    chunks.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page.at(-1);
    if (!last) break;
    afterAttempt = last.attempt.attempt;
    afterSequence = last.sequence;
  }
  return concatenateBase64(chunks);
}

export async function buildRawOutput(
  buildId: string,
): Promise<Uint8Array | null> {
  const { buildsService } = getServerServices();
  if (!(await buildsService.getBuild(buildId))) return null;

  const chunks: Array<{ dataBase64: string }> = [];
  let after: string | null = null;
  while (true) {
    const page = await buildsService.logChunks(buildId, after, PAGE_SIZE);
    chunks.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page.at(-1);
    if (!last) break;
    after = last.id;
  }
  return concatenateBase64(chunks);
}

export function rawOutputResponse(
  output: Uint8Array | null,
  filename: string,
): Response {
  if (output === null) {
    return new Response("Output not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const safeFilename = filename.replace(/["\r\n]/g, "_");
  const body = new ArrayBuffer(output.byteLength);
  new Uint8Array(body).set(output);
  return new Response(body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "content-length": String(output.byteLength),
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
