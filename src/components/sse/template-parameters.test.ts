import { describe, expect, test } from "vitest";

import type { SseMockTemplate } from "./types";
import {
  sseTemplateBlockError,
  sseTemplateDraftError,
  sseTemplateValuesInput,
  sseTemplateValuesRecord,
} from "./template-parameters";

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
      helpText: "",
      type: "BOOLEAN",
      required: false,
      defaultValue: "true",
    },
  ],
};

describe("SSE template builder parameters", () => {
  test("requires missing values and accepts defaults", () => {
    expect(sseTemplateBlockError(template, {})).toBe("Name is required.");
    expect(sseTemplateBlockError(template, { "name-id": "Ada" })).toBeNull();
  });

  test("validates typed block overrides", () => {
    expect(
      sseTemplateBlockError(template, {
        "name-id": "Ada",
        "active-id": "TRUE",
      }),
    ).toBe("Active: Choose true or false.");
  });

  test("validates definition order, keys, defaults, and placeholder use", () => {
    expect(
      sseTemplateDraftError({
        name: template.name,
        eventName: template.eventName ?? "",
        data: template.data,
        eventId: "",
        retryMs: "",
        retryMsTemplate: "",
        fields: template.fields,
      }),
    ).toBeNull();
    expect(
      sseTemplateDraftError({
        name: template.name,
        eventName: "message",
        data: "constant",
        eventId: "",
        retryMs: "",
        retryMsTemplate: "",
        fields: template.fields,
      }),
    ).toBe("Field name is not used in the event.");
  });

  test("hydrates independent overrides and produces mutation inputs", () => {
    const first = sseTemplateValuesRecord([
      { fieldId: "name-id", value: "Ada" },
    ]);
    const second = sseTemplateValuesRecord([
      { fieldId: "name-id", value: "Grace" },
    ]);
    expect(first).not.toEqual(second);
    expect(sseTemplateValuesInput(first)).toEqual([
      { fieldId: "name-id", value: "Ada" },
    ]);
  });
});
