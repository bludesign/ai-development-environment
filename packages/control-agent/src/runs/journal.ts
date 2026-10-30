import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentGraphQLClient } from "../graphql-client.js";
import { configPath } from "../config.js";
import type { ProviderEvent } from "./provider.js";

type JournalEvent = ProviderEvent & {
  id: string;
  sequence: number;
  attemptId: string | null;
};

export class RunJournal {
  private nextSequence = 0;
  private acknowledged = -1;
  private acknowledgedOffset = 0;
  private loaded = false;
  private loading?: Promise<void>;
  private appending: Promise<void> = Promise.resolve();
  private saving: Promise<void> = Promise.resolve();
  private flushing?: Promise<void>;

  constructor(
    private readonly runId: string,
    private attemptId: string | null,
  ) {}

  setAttempt(attemptId: string | null): void {
    this.attemptId = attemptId;
  }

  private get directory(): string {
    return join(dirname(configPath()), "runs", this.runId);
  }

  private get eventsPath(): string {
    return join(this.directory, "events.jsonl");
  }

  private get statePath(): string {
    return join(this.directory, "state.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = this.loadState().finally(() => {
        this.loading = undefined;
      });
    }
    await this.loading;
  }

  private async loadState(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as {
        acknowledged?: number;
        nextSequence?: number;
        acknowledgedOffset?: number;
      };
      this.acknowledged = state.acknowledged ?? -1;
      this.nextSequence = state.nextSequence ?? 0;
      this.acknowledgedOffset = state.acknowledgedOffset ?? 0;
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw error;
    }
    const size = await stat(this.eventsPath).then(
      ({ size }) => size,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      },
    );
    if (
      !Number.isSafeInteger(this.acknowledgedOffset) ||
      this.acknowledgedOffset < 0 ||
      this.acknowledgedOffset > size
    )
      this.acknowledgedOffset = 0;
    this.nextSequence = Math.max(this.nextSequence, this.acknowledged + 1);
    // Recover appends that reached disk before state.json did. Legacy state
    // files have no byte offset; scan their acknowledged prefix just once.
    let completeOffset = this.acknowledgedOffset;
    for await (const { event, endOffset } of this.readEvents(completeOffset)) {
      this.nextSequence = Math.max(this.nextSequence, event.sequence + 1);
      if (event.sequence <= this.acknowledged) {
        this.acknowledgedOffset = endOffset;
      }
      completeOffset = endOffset;
    }
    // A crash can leave an incomplete last line. Do not join the next event
    // onto that fragment or advance the acknowledgement past it.
    if (size > completeOffset) {
      await truncate(this.eventsPath, completeOffset);
    }
    await this.saveState();
    this.loaded = true;
  }

  async append(event: ProviderEvent): Promise<JournalEvent> {
    const operation = this.appending.then(async () => {
      await this.load();
      const value: JournalEvent = {
        ...event,
        id: randomUUID(),
        sequence: this.nextSequence++,
        attemptId: this.attemptId,
      };
      await appendFile(this.eventsPath, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await this.saveState();
      return value;
    });
    this.appending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async latestSequence(): Promise<number> {
    await this.load();
    return this.nextSequence - 1;
  }

  async flush(client: AgentGraphQLClient): Promise<void> {
    // Each caller waits for its own output to drain, including callers that
    // append while another upload is in flight or finishes with an error.
    const previous = this.flushing;
    const operation = (async () => {
      await previous?.catch(() => undefined);
      await this.load();
      await this.appending;
      await this.flushInternal(client);
    })();
    this.flushing = operation;
    try {
      await operation;
    } finally {
      if (this.flushing === operation) this.flushing = undefined;
    }
  }

  private async flushInternal(client: AgentGraphQLClient): Promise<void> {
    let chunk: JournalEvent[] = [];
    let endOffset = this.acknowledgedOffset;
    const upload = async () => {
      if (!chunk.length) return;
      await client.appendRunEvents(
        this.runId,
        chunk[0]!.attemptId ?? this.attemptId,
        chunk.map((value) => {
          const event: Record<string, unknown> = { ...value };
          Reflect.deleteProperty(event, "attemptId");
          return event;
        }),
      );
      this.acknowledged = chunk.at(-1)!.sequence;
      this.acknowledgedOffset = endOffset;
      await this.saveState();
      chunk = [];
    };
    for await (const entry of this.readEvents(this.acknowledgedOffset)) {
      if (
        chunk.length &&
        (chunk.length === 100 ||
          (chunk[0]!.attemptId ?? this.attemptId) !==
            (entry.event.attemptId ?? this.attemptId))
      )
        await upload();
      chunk.push(entry.event);
      endOffset = entry.endOffset;
    }
    await upload();
  }

  private async *readEvents(start: number): AsyncGenerator<{
    event: JournalEvent;
    endOffset: number;
  }> {
    const stream = createReadStream(this.eventsPath, { start });
    let pending: Buffer = Buffer.alloc(0);
    let offset = start;
    try {
      for await (const bytes of stream) {
        const buffer = Buffer.concat([pending, bytes as Buffer]);
        let index = 0;
        let newline: number;
        while ((newline = buffer.indexOf(10, index)) !== -1) {
          const line = buffer.subarray(index, newline);
          offset += newline - index + 1;
          index = newline + 1;
          if (line.length) {
            yield {
              event: JSON.parse(line.toString("utf8")) as JournalEvent,
              endOffset: offset,
            };
          }
        }
        pending = buffer.subarray(index);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    } finally {
      stream.destroy();
    }
  }

  private saveState(): Promise<void> {
    const contents = `${JSON.stringify({ acknowledged: this.acknowledged, nextSequence: this.nextSequence, acknowledgedOffset: this.acknowledgedOffset })}\n`;
    const operation = this.saving.then(async () => {
      const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { mode: 0o600 });
        await rename(temporary, this.statePath);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.saving = operation.catch(() => undefined);
    return operation;
  }
}
