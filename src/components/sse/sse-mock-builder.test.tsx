import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SseMockComposition, SseMockTemplate } from "./types";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: request,
}));

import { MockBuilder } from "./sse-endpoint-editor-page";

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const template: SseMockTemplate = {
  id: "template-1",
  endpointId: "endpoint-1",
  name: "Greeting",
  eventName: "greeting",
  data: '{"name":{{json:name}},"active":{{json:active}}}',
  eventId: null,
  retryMs: null,
  retryMsTemplate: null,
  fields: [
    {
      id: "name-id",
      key: "name",
      label: "Name",
      helpText: "Recipient name",
      type: "TEXT",
      required: true,
      defaultValue: null,
    },
    {
      id: "active-id",
      key: "active",
      label: "Active",
      helpText: "Whether the greeting is active",
      type: "BOOLEAN",
      required: false,
      defaultValue: "true",
    },
  ],
};

const composition: SseMockComposition = {
  id: "composition-1",
  name: "Greeting sequence",
  statusCode: 200,
  headers: [{ name: "Content-Type", value: "text/event-stream" }],
  blocks: [
    {
      id: "block-1",
      kind: "EVENT",
      delayMs: null,
      script: null,
      customEvent: null,
      template,
      templateValues: [{ fieldId: "name-id", value: "Ada" }],
    },
  ],
  createdAt: null,
  updatedAt: null,
};

const countTemplate: SseMockTemplate = {
  ...template,
  id: "template-2",
  name: "Counter",
  data: '{"count":{{json:count}}}',
  fields: [
    {
      id: "count-id",
      key: "count",
      label: "Count",
      helpText: "",
      type: "NUMBER",
      required: true,
      defaultValue: null,
    },
  ],
};

const reorderComposition: SseMockComposition = {
  ...composition,
  id: "composition-reorder",
  name: "Reorder sequence",
  blocks: ["first", "second", "third"].map((eventName, index) => ({
    id: `block-${index + 1}`,
    kind: "EVENT" as const,
    delayMs: null,
    script: null,
    customEvent: {
      eventName,
      data:
        index === 0
          ? `{"identifier":"${"long-event-value-".repeat(30)}"}`
          : eventName,
      eventId: null,
      retryMs: null,
    },
    template: null,
    templateValues: [],
  })),
};

describe("SSE mock builder template parameters", () => {
  beforeEach(() => {
    cleanup();
    request.mockReset();
  });

  test("hydrates dynamic controls, validates reset values, and sends overrides", async () => {
    request.mockResolvedValue({
      saveSseMockComposition: composition,
    });
    const changed = vi.fn(async () => undefined);
    render(
      <MockBuilder
        activeCompositionId={composition.id}
        compositions={[composition]}
        endpointId="endpoint-1"
        onChanged={changed}
        templates={[template, countTemplate]}
      />,
    );

    const name = await screen.findByRole("textbox", { name: "Name" });
    expect((name as HTMLInputElement).value).toBe("Ada");
    expect(screen.getByText("Using default: true")).toBeTruthy();
    expect(screen.getAllByText("2 parameters")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Reset" })[0]!);
    expect(screen.getByText("A value is required.")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Save composition",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.change(name, { target: { value: "Grace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save composition" }));

    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation SaveSseComposition"),
      expect.objectContaining({
        endpointId: "endpoint-1",
        id: "composition-1",
        input: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              templateId: "template-1",
              templateValues: [{ fieldId: "name-id", value: "Grace" }],
            }),
          ],
        }),
      }),
    );

    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Event block source" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByRole("option", { name: "Counter" }));
    expect(
      await screen.findByRole("spinbutton", { name: "Count" }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.getByText("A value is required.")).toBeTruthy();
  });

  test("wraps long event content and reorders blocks by position", async () => {
    request.mockResolvedValue({
      saveSseMockComposition: reorderComposition,
    });
    render(
      <MockBuilder
        activeCompositionId={reorderComposition.id}
        compositions={[reorderComposition]}
        endpointId="endpoint-1"
        onChanged={vi.fn(async () => undefined)}
        templates={[]}
      />,
    );

    const eventData = await screen.findAllByRole("textbox", {
      name: "Event data",
    });
    expect(eventData[0]!.className).toContain("[overflow-wrap:anywhere]");
    expect(eventData[0]!.className).toContain("max-w-full");
    const firstBlock = eventData[0]!.closest('[data-slot="sse-mock-block"]');
    expect(firstBlock?.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(firstBlock?.className).toContain("min-w-0");

    const thirdPosition = screen.getByRole("spinbutton", {
      name: "Block 3 position",
    });
    fireEvent.focus(thirdPosition);
    fireEvent.change(thirdPosition, { target: { value: "1" } });
    fireEvent.blur(thirdPosition);

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("textbox", { name: "Event name" })
          .map((input) => (input as HTMLInputElement).value),
      ).toEqual(["third", "first", "second"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save composition" }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("mutation SaveSseComposition"),
      expect.objectContaining({
        input: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              customEvent: expect.objectContaining({ eventName: "third" }),
            }),
            expect.objectContaining({
              customEvent: expect.objectContaining({ eventName: "first" }),
            }),
            expect.objectContaining({
              customEvent: expect.objectContaining({ eventName: "second" }),
            }),
          ],
        }),
      }),
    );
  });
});
