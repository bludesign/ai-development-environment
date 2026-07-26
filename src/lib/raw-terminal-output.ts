import "server-only";

import { Buffer } from "node:buffer";

import { getServerServices } from "@/services/server-services";

const PAGE_SIZE = 100;

function streamBase64Pages(
  loadPage: () => Promise<Array<{ dataBase64: string }>>,
): ReadableStream<Uint8Array> {
  const iterator = (async function* () {
    while (true) {
      const page = await loadPage();
      for (const chunk of page) {
        yield Buffer.from(chunk.dataBase64, "base64");
      }
      if (page.length < PAGE_SIZE) return;
    }
  })();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

export async function commandRunRawOutput(
  runId: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const { commandsService } = getServerServices();
  if (!(await commandsService.getRun(runId))) return null;

  let afterAttempt = 0;
  let afterSequence = -1;
  return streamBase64Pages(async () => {
    const page = await commandsService.listOutput(
      runId,
      afterAttempt,
      afterSequence,
      PAGE_SIZE,
    );
    const last = page.at(-1);
    if (last) {
      afterAttempt = last.attempt.attempt;
      afterSequence = last.sequence;
    }
    return page;
  });
}

export async function buildRawOutput(
  buildId: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const { buildsService } = getServerServices();
  if (!(await buildsService.getBuild(buildId))) return null;

  let after: string | null = null;
  return streamBase64Pages(async () => {
    const page = await buildsService.logChunks(buildId, after, PAGE_SIZE);
    const last = page.at(-1);
    if (last) after = last.id;
    return page;
  });
}

export function rawOutputResponse(
  output: ReadableStream<Uint8Array> | null,
  filename: string,
): Response {
  if (output === null) {
    return new Response("Output not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const safeFilename = filename.replace(/["\r\n]/g, "_");
  return new Response(output, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
