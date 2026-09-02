import { describe, expect, test } from "vitest";

import { SseEventNormalizer, SseParser, encodeSseEvent } from "./sse-parser";

describe("SseParser", () => {
  test("parses fragmented CRLF frames, multiline data, ids, retry, and comments", () => {
    const parser = new SseParser();
    const events = [
      ...parser.push(
        ":ignored\r\nevent: card\r\nid: 12\r\nretry: 1000\r\ndata: one\r",
      ),
      ...parser.push("\ndata:two\r\n\r\ndata: final"),
      ...parser.finish(),
    ];
    expect(events).toEqual([
      {
        event: "card",
        data: "one\ntwo",
        dataLines: ["one", "two"],
        id: "12",
        retry: 1000,
      },
      {
        event: null,
        data: "final",
        dataLines: ["final"],
        id: undefined,
        retry: null,
      },
    ]);
  });

  test("concatenates unnamed frames into the requested four history items", () => {
    const input = [
      'event:display_card\ndata:{"title":"test"}\n\n',
      "data:Good morning\n\n",
      "data:\n\n",
      "data:How are you?\n\n",
      'event:loading\ndata:{"text":"Loading"}\n\n',
      "data:What \n\n",
      "data:w\n\n",
      "data:ould you like to work on?\n\n",
    ].join("");
    const parser = new SseParser();
    const normalizer = new SseEventNormalizer("CONCATENATE");
    const values = parser
      .push(input)
      .flatMap((event) => normalizer.push(event));
    values.push(...normalizer.flush());
    expect(
      values.map(({ event, data }) => ({ event: event || "text", data })),
    ).toEqual([
      { event: "display_card", data: '{"title":"test"}' },
      { event: "text", data: "Good morning\nHow are you?" },
      { event: "loading", data: '{"text":"Loading"}' },
      { event: "text", data: "What would you like to work on?" },
    ]);
  });

  test("preserves unnamed frames and supports buffer splits", () => {
    const preserve = new SseEventNormalizer("PRESERVE_FRAMES");
    expect(
      preserve
        .push({ data: "one\ntwo", dataLines: ["one", "two"] })
        .map(({ data }) => data),
    ).toEqual(["one\ntwo"]);

    const concatenate = new SseEventNormalizer("CONCATENATE");
    concatenate.push({ data: "first\n\nsecond" });
    expect(concatenate.splitAt(5, 2).map(({ data }) => data)).toEqual([
      "first",
    ]);
    expect(concatenate.flush().map(({ data }) => data)).toEqual(["second"]);

    const inherited = new SseEventNormalizer("CONCATENATE");
    inherited.push({ data: "waiting" });
    inherited.inheritId("1349872");
    inherited.push({ data: "", id: "" });
    expect(inherited.flush()[0]?.id).toBe("1349872");
  });

  test("encodes fields and every data line", () => {
    expect(
      new TextDecoder().decode(
        encodeSseEvent({
          event: "message",
          id: "42",
          retry: 500,
          data: "a\nb",
        }),
      ),
    ).toBe("event:message\nid:42\nretry:500\ndata:a\ndata:b\n\n");
  });

  test("preserves control-only frames without dispatching empty messages", () => {
    const parser = new SseParser();
    const events = parser.push("retry:5000\n\nid:42\n\n");

    expect(events).toEqual([
      {
        event: null,
        data: "",
        dataLines: [],
        id: undefined,
        retry: 5000,
        dispatch: false,
      },
      {
        event: null,
        data: "",
        dataLines: [],
        id: "42",
        retry: null,
        dispatch: false,
      },
    ]);
    expect(
      events.map((event) => new TextDecoder().decode(encodeSseEvent(event))),
    ).toEqual(["retry:5000\n\n", "id:42\n\n"]);
  });
});
