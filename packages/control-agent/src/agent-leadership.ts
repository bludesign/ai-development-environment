import { createHash } from "node:crypto";
import { createServer } from "node:net";

/** A kernel-held lease: crashes release it without stale-file or PID races. */
export async function acquireAgentLeadership(
  agentId: string,
  port?: number,
): Promise<{ port: number; release: () => Promise<void> }> {
  const chosenPort =
    port ??
    30_000 +
      (createHash("sha256").update(agentId).digest().readUInt32BE() % 30_000);
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Another runtime may already own agent ${agentId}; its exclusive local runtime port ${chosenPort} is in use`,
            )
          : error,
      );
    });
    server.listen(
      { host: "127.0.0.1", port: chosenPort, exclusive: true },
      () => resolve(),
    );
  });
  server.unref();
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : chosenPort,
    release: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
