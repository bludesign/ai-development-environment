import { beforeEach, expect, test, vi } from "vitest";

const commandsService = vi.hoisted(() => ({
  getRun: vi.fn(),
  listOutput: vi.fn(),
}));
const buildsService = vi.hoisted(() => ({
  getBuild: vi.fn(),
  logChunks: vi.fn(),
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ commandsService, buildsService }),
}));

import {
  buildRawOutput,
  commandRunRawOutput,
  rawOutputResponse,
} from "./raw-terminal-output";

const PAGE_SIZE = 100;

async function streamBytes(
  stream: ReadableStream<Uint8Array> | null,
): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0);
  return Buffer.from(await new Response(stream).arrayBuffer());
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("returns command output as the exact stored bytes", async () => {
  commandsService.getRun.mockResolvedValue({ id: "run-1" });
  commandsService.listOutput.mockResolvedValue([
    {
      dataBase64: Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]).toString(
        "base64",
      ),
      sequence: 0,
      attempt: { attempt: 1 },
    },
    {
      dataBase64: Buffer.from("hello\n").toString("base64"),
      sequence: 1,
      attempt: { attempt: 1 },
    },
  ]);

  const output = await commandRunRawOutput("run-1");

  expect(await streamBytes(output)).toEqual(
    Buffer.concat([
      Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]),
      Buffer.from("hello\n"),
    ]),
  );
});

test("returns build log bytes in service order", async () => {
  buildsService.getBuild.mockResolvedValue({ id: "build-1" });
  buildsService.logChunks.mockResolvedValue([
    {
      id: "log-1",
      dataBase64: Buffer.from("compile\n").toString("base64"),
    },
    {
      id: "log-2",
      dataBase64: Buffer.from("done\n").toString("base64"),
    },
  ]);

  const output = await buildRawOutput("build-1");

  expect((await streamBytes(output)).toString()).toBe("compile\ndone\n");
});

test("streams command output across bounded pages", async () => {
  commandsService.getRun.mockResolvedValue({ id: "run-1" });
  const firstPage = Array.from({ length: PAGE_SIZE }, (_, sequence) => ({
    dataBase64: Buffer.from("a").toString("base64"),
    sequence,
    attempt: { attempt: 1 },
  }));
  commandsService.listOutput
    .mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce([
      {
        dataBase64: Buffer.from("b").toString("base64"),
        sequence: PAGE_SIZE,
        attempt: { attempt: 1 },
      },
    ]);

  const output = await commandRunRawOutput("run-1");

  expect((await streamBytes(output)).toString()).toBe(
    `${"a".repeat(PAGE_SIZE)}b`,
  );
  expect(commandsService.listOutput).toHaveBeenNthCalledWith(
    1,
    "run-1",
    0,
    -1,
    PAGE_SIZE,
  );
  expect(commandsService.listOutput).toHaveBeenNthCalledWith(
    2,
    "run-1",
    1,
    PAGE_SIZE - 1,
    PAGE_SIZE,
  );
});

test("streams build output across bounded pages", async () => {
  buildsService.getBuild.mockResolvedValue({ id: "build-1" });
  const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => ({
    id: `log-${index}`,
    dataBase64: Buffer.from("a").toString("base64"),
  }));
  buildsService.logChunks
    .mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce([
      {
        id: `log-${PAGE_SIZE}`,
        dataBase64: Buffer.from("b").toString("base64"),
      },
    ]);

  const output = await buildRawOutput("build-1");

  expect((await streamBytes(output)).toString()).toBe(
    `${"a".repeat(PAGE_SIZE)}b`,
  );
  expect(buildsService.logChunks).toHaveBeenNthCalledWith(
    1,
    "build-1",
    null,
    PAGE_SIZE,
  );
  expect(buildsService.logChunks).toHaveBeenNthCalledWith(
    2,
    "build-1",
    `log-${PAGE_SIZE - 1}`,
    PAGE_SIZE,
  );
});

test("returns null for an output whose parent no longer exists", async () => {
  commandsService.getRun.mockResolvedValue(null);
  buildsService.getBuild.mockResolvedValue(null);

  await expect(commandRunRawOutput("missing-run")).resolves.toBeNull();
  await expect(buildRawOutput("missing-build")).resolves.toBeNull();
  expect(commandsService.listOutput).not.toHaveBeenCalled();
  expect(buildsService.logChunks).not.toHaveBeenCalled();
});

test("serves raw output inline as a saveable text file", async () => {
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hello\n"));
      controller.close();
    },
  });
  const response = rawOutputResponse(
    output,
    "command-run-1-output.txt",
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe(
    "text/plain; charset=utf-8",
  );
  expect(response.headers.get("content-disposition")).toContain(
    'inline; filename="command-run-1-output.txt"',
  );
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.has("content-length")).toBe(false);
  await expect(response.text()).resolves.toBe("hello\n");
});
