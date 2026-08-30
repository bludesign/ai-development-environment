import type { SseBufferMode, SseEvent } from "./types";

export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | null = null;
  private eventId: string | null | undefined;
  private retry: number | null = null;
  private sawField = false;
  private firstLine = true;

  push(chunk: Uint8Array | string): SseEvent[] {
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });
    return this.consumeLines(false);
  }

  finish(): SseEvent[] {
    this.buffer += this.decoder.decode();
    const events = this.consumeLines(true);
    const final = this.dispatch();
    if (final) events.push(final);
    return events;
  }

  private consumeLines(finishing: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    while (this.buffer.length) {
      let lineEnd = -1;
      let terminatorLength = 0;
      for (let index = 0; index < this.buffer.length; index += 1) {
        const character = this.buffer[index];
        if (character === "\n") {
          lineEnd = index;
          terminatorLength = 1;
          break;
        }
        if (character === "\r") {
          if (index + 1 === this.buffer.length && !finishing) return events;
          lineEnd = index;
          terminatorLength = this.buffer[index + 1] === "\n" ? 2 : 1;
          break;
        }
      }
      if (lineEnd < 0) {
        if (!finishing) return events;
        lineEnd = this.buffer.length;
      }
      let line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + terminatorLength);
      if (this.firstLine) {
        this.firstLine = false;
        if (line.startsWith("\uFEFF")) line = line.slice(1);
      }
      const event = this.consumeLine(line);
      if (event) events.push(event);
      if (terminatorLength === 0) break;
    }
    return events;
  }

  private consumeLine(line: string): SseEvent | null {
    if (!line) return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.sawField = true;
        this.dataLines.push(value);
        break;
      case "event":
        this.sawField = true;
        this.eventName = value || null;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.sawField = true;
          this.eventId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          this.sawField = true;
          this.retry = Number(value);
        }
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    if (!this.sawField) return null;
    const event: SseEvent = {
      event: this.eventName,
      data: this.dataLines.join("\n"),
      dataLines: [...this.dataLines],
      id: this.eventId,
      retry: this.retry,
    };
    this.dataLines = [];
    this.eventName = null;
    this.eventId = undefined;
    this.retry = null;
    this.sawField = false;
    return event;
  }
}

export class SseEventNormalizer {
  private pending: SseEvent | null = null;

  constructor(private readonly mode: SseBufferMode) {}

  push(event: SseEvent): SseEvent[] {
    if (this.mode === "STANDARD") return [event];
    if (this.mode === "PRESERVE_FRAMES") return [event];
    if (event.event) {
      const values = this.flush();
      values.push(event);
      return values;
    }
    if (!this.pending) {
      this.pending = { ...event, event: null, data: "", dataLines: [] };
    }
    this.pending.data += event.data === "" ? "\n" : event.data;
    this.pending.dataLines?.push(...(event.dataLines ?? [event.data]));
    if (
      event.id !== undefined &&
      (event.id !== "" || this.pending.id == null)
    ) {
      this.pending.id = event.id;
    }
    if (event.retry !== null && event.retry !== undefined) {
      this.pending.retry = event.retry;
    }
    return [];
  }

  flush(): SseEvent[] {
    if (!this.pending) return [];
    const event = this.pending;
    this.pending = null;
    return [event];
  }

  splitAt(offset: number, discard = 0): SseEvent[] {
    if (!this.pending) return [];
    if (!Number.isInteger(offset) || !Number.isInteger(discard)) {
      throw new Error("SSE buffer split offsets must be integers");
    }
    if (
      offset < 0 ||
      discard < 0 ||
      offset + discard > this.pending.data.length
    ) {
      throw new Error("SSE buffer split is outside the current buffer");
    }
    const completed: SseEvent = {
      ...this.pending,
      data: this.pending.data.slice(0, offset),
      dataLines: undefined,
    };
    const remainder = this.pending.data.slice(offset + discard);
    this.pending = remainder
      ? { ...this.pending, data: remainder, dataLines: undefined }
      : null;
    return [completed];
  }

  inheritId(id: string): void {
    if (this.pending && this.pending.id == null) this.pending.id = id;
  }

  get text(): string {
    return this.pending?.data ?? "";
  }
}

export function encodeSseEvent(event: SseEvent): Uint8Array {
  const lines: string[] = [];
  if (event.event) lines.push(`event:${event.event}`);
  if (event.id !== undefined && event.id !== null) lines.push(`id:${event.id}`);
  if (event.retry !== undefined && event.retry !== null) {
    lines.push(`retry:${event.retry}`);
  }
  for (const line of event.data.split("\n")) lines.push(`data:${line}`);
  lines.push("", "");
  return new TextEncoder().encode(lines.join("\n"));
}
