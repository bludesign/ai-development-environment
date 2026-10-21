import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { RunQuestionField } from "@ai-development-environment/agent-contract/run-forms";
import {
  NativeRunForm,
  nativeFormValues,
  type NativeFormDraft,
} from "./native-run-form";

afterEach(cleanup);
function Editor({
  fields,
  initial = {},
}: {
  fields: RunQuestionField[];
  initial?: NativeFormDraft;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <NativeRunForm fields={fields} draft={draft} onChange={setDraft} />
      <output data-testid="values">
        {JSON.stringify(nativeFormValues(fields, draft))}
      </output>
    </>
  );
}
describe("native form controls", () => {
  test("does not invent default values in unanswered history", () => {
    render(
      <NativeRunForm
        fields={[{ key: "n", title: "Count", type: "integer", default: 12 }]}
        draft={{}}
        onChange={() => undefined}
        readOnly
      />,
    );
    expect(screen.getByText("—")).toBeDefined();
    expect(screen.queryByText("12")).toBeNull();
  });
  test("renders numeric zero, text formats, and hidden defaults without losing native types", () => {
    render(
      <Editor
        fields={[
          { key: "n", title: "Count", type: "integer", default: 0 },
          { key: "email", title: "Email", type: "string", format: "email" },
          { key: "hidden", type: "string", hidden: true, default: "kept" },
        ]}
      />,
    );
    expect(
      (screen.getByRole("spinbutton", { name: "Count" }) as HTMLInputElement)
        .value,
    ).toBe("0");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Count" }), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "person@example.test" },
    });
    expect(JSON.parse(screen.getByTestId("values").textContent!)).toEqual({
      n: 7,
      email: "person@example.test",
      hidden: "kept",
    });
    expect(screen.queryByLabelText("hidden")).toBeNull();
  });
  test("uses option values and toggles conditional fields", () => {
    render(
      <Editor
        fields={[
          {
            key: "choice",
            title: "Choice",
            type: "string",
            options: [{ value: "native-id", label: "Friendly name" }],
          },
          {
            key: "detail",
            title: "Details",
            type: "string",
            when: [{ key: "choice", op: "eq", value: "native-id" }],
          },
        ]}
      />,
    );
    expect(screen.queryByRole("textbox", { name: "Details" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("textbox", { name: "Details" })).toBeDefined();
    fireEvent.change(screen.getByRole("textbox", { name: "Details" }), {
      target: { value: "details" },
    });
    expect(JSON.parse(screen.getByTestId("values").textContent!)).toEqual({
      choice: "native-id",
      detail: "details",
    });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(JSON.parse(screen.getByTestId("values").textContent!)).toEqual({});
  });
  test("keeps multiselect custom values alongside native options", () => {
    render(
      <Editor
        fields={[
          {
            key: "list",
            title: "List",
            type: "multiselect",
            custom: true,
            options: [{ value: "a", label: "Option A" }],
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom answer" }), {
      target: { value: "custom\nanother" },
    });
    expect(JSON.parse(screen.getByTestId("values").textContent!)).toEqual({
      list: ["a", "custom", "another"],
    });
  });
  test("opening an external link does not acknowledge completion", () => {
    render(
      <Editor
        fields={[
          {
            key: "external",
            title: "Authorize",
            type: "external",
            url: "https://example.test/authorize",
          },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "Open link" });
    expect(link.getAttribute("href")).toBe("https://example.test/authorize");
    expect(screen.getByTestId("values").textContent).toBe("{}");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByTestId("values").textContent).toBe('{"external":true}');
  });
  test("reloads typed false and numeric zero in answer history", () => {
    render(
      <NativeRunForm
        fields={[
          { key: "bool", title: "Enabled", type: "boolean" },
          { key: "n", title: "Count", type: "number" },
        ]}
        draft={{ bool: false, n: 0 }}
        onChange={() => undefined}
        readOnly
      />,
    );
    expect(screen.getByText("No")).toBeDefined();
    expect(screen.getByText("0")).toBeDefined();
  });
});
