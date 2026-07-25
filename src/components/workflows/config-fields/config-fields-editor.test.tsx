import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { ConfigFieldsEditor } from "./config-fields-editor";

function Harness({
  config: initial,
  kind,
}: {
  config: Record<string, unknown>;
  kind: string;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <TooltipProvider>
      <ConfigFieldsEditor
        config={config}
        kind={kind}
        onChange={setConfig}
        scope="step"
        sessionPaths={[
          { path: "pr.labels", description: "Pull request labels" },
        ]}
      />
      <pre data-testid="config">{JSON.stringify(config)}</pre>
    </TooltipProvider>
  );
}

const config = () => JSON.parse(screen.getByTestId("config").textContent!);

afterEach(() => cleanup());

describe("interactive step configuration", () => {
  test("builds an if condition from comparison rows", () => {
    render(<Harness config={{}} kind="CONTROL_IF" />);

    fireEvent.click(screen.getByRole("button", { name: "Add comparison" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Compared value" }), {
      target: { value: "ready" },
    });

    expect(config().condition).toEqual({
      op: "EQ",
      left: { source: "SESSION", path: "" },
      right: "ready",
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(config().condition).toBeUndefined();
  });

  test("keeps the JSON control for a condition the rows cannot draw", () => {
    render(
      <Harness
        config={{ condition: { op: "ALL", conditions: [{ op: "ANY" }] } }}
        kind="CONTROL_IF"
      />,
    );

    expect(screen.queryByRole("button", { name: "Add comparison" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Condition" })).toBeTruthy();
  });

  test("edits human choice buttons as labelled rows", () => {
    render(
      <Harness
        config={{ options: [{ label: "Ship it" }] }}
        kind="HUMAN_CHOICE"
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Description (optional)" }),
      {
        target: { value: "Merge and deploy" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));

    const labels = screen.getAllByRole("textbox", { name: "Button label" });
    fireEvent.change(labels[1]!, { target: { value: "Hold" } });

    expect(config().options).toEqual([
      { label: "Ship it", description: "Merge and deploy" },
      { label: "Hold" },
    ]);
  });

  test("preserves structured terminal credential entries while editing", () => {
    const credentials = [
      {
        name: "WORKFLOW_SECRET",
        credential: { id: "credential-1", kind: "TOKEN", ownerId: null },
      },
    ];
    render(<Harness config={{ credentials }} kind="TERMINAL_RUN" />);

    fireEvent.change(
      screen.getByRole("textbox", { name: "Credential environment" }),
      {
        target: {
          value: JSON.stringify([
            {
              ...credentials[0],
              name: "UPDATED_SECRET",
            },
          ]),
        },
      },
    );

    expect(config().credentials).toEqual([
      {
        name: "UPDATED_SECRET",
        credential: { id: "credential-1", kind: "TOKEN", ownerId: null },
      },
    ]);
  });
});
