import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
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
  private loaded = false;
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
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as {
        acknowledged?: number;
        nextSequence?: number;
      };
      this.acknowledged = state.acknowledged ?? -1;
      this.nextSequence = state.nextSequence ?? 0;
    } catch {
      try {
        const events = await this.readEvents();
        this.nextSequence = (events.at(-1)?.sequence ?? -1) + 1;
      } catch {
        this.nextSequence = 0;
      }
    }
    this.loaded = true;
  }

  async append(event: ProviderEvent): Promise<JournalEvent> {
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
  }

  async latestSequence(): Promise<number> {
    await this.load();
    return this.nextSequence - 1;
  }

  async flush(client: AgentGraphQLClient): Promise<void> {
    await this.load();
    if (this.flushing) return this.flushing;
    this.flushing = this.flushInternal(client).finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async flushInternal(client: AgentGraphQLClient): Promise<void> {
    const pending = (await this.readEvents()).filter(
      ({ sequence }) => sequence > this.acknowledged,
    );
    for (let index = 0; index < pending.length;) {
      const attemptId = pending[index]!.attemptId ?? this.attemptId;
      let end = index + 1;
      while (
        end < pending.length &&
        end - index < 100 &&
        (pending[end]!.attemptId ?? this.attemptId) === attemptId
      ) {
        end += 1;
      }
      const chunk = pending.slice(index, end);
      await client.appendRunEvents(
        this.runId,
        attemptId,
        chunk.map((value) => {
          const event: Record<string, unknown> = { ...value };
          Reflect.deleteProperty(event, "attemptId");
          return event;
        }),
      );
      this.acknowledged = chunk.at(-1)!.sequence;
      await this.saveState();
      index = end;
    }
  }

  private async readEvents(): Promise<JournalEvent[]> {
    try {
      return (await readFile(this.eventsPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async saveState(): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ acknowledged: this.acknowledged, nextSequence: this.nextSequence })}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, this.statePath);
  }
}
