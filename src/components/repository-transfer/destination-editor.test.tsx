import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { TransferDestinationEditor } from "./destination-editor";
import type {
  TransferAgent,
  TransferDestination,
  TransferDestinationInput,
  TransferItem,
} from "./types";

afterEach(cleanup);

const repository: TransferItem = {
  key: "repository:mobile",
  parentKey: null,
  kind: "REPOSITORY",
  label: "Mobile",
  repositoryKey: "repository:mobile",
  selected: true,
  dependency: false,
  action: "IMPORT",
  targetId: "local-repository",
  candidates: [],
  current: null,
  incoming: {
    canonicalOrigin: "github.com/acme/mobile",
    remoteUrl: "git@github.com:acme/mobile.git",
  },
  affectedRepositories: [],
  warnings: [],
};
const agent: TransferAgent = {
  id: "studio",
  name: "Studio",
  baseRepoDirectory: "/Repos",
  eligible: true,
  reason: null,
};
const existing: TransferDestination = {
  repositoryKey: repository.key,
  repositoryId: "local-repository",
  agentId: agent.id,
  remoteUrl: "git@github.com:acme/mobile.git",
  relativePath: "mobile",
  destinationPath: "/Workspaces/my-mobile-checkout",
  status: "REUSE",
  error: null,
};

test("import can select an agent whose only repository already exists and reuses its real checkout", () => {
  const onChange = vi.fn();
  function Harness() {
    const [destinations, setDestinations] = useState<
      TransferDestinationInput[]
    >([]);
    return (
      <TransferDestinationEditor
        allowExisting
        agents={[agent]}
        repositories={[repository]}
        destinations={destinations}
        coverage={[existing]}
        onChange={(values) => {
          setDestinations(values);
          onChange(values);
        }}
      />
    );
  }
  render(<Harness />);
  expect(screen.getByText("Already present")).toBeDefined();
  expect(screen.queryByText("Missing")).toBeNull();
  const select = screen.getByRole("checkbox", { name: "Import to this agent" });
  expect((select as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(select);
  expect(onChange).toHaveBeenLastCalledWith([
    {
      repositoryKey: repository.key,
      agentId: agent.id,
      relativePath: "mobile",
      remoteUrl: existing.remoteUrl,
    },
  ]);
  expect(screen.getByText(existing.destinationPath)).toBeDefined();
  expect(screen.queryByText("/Repos/mobile")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("sync skips present checkouts and distinguishes missing, blocked, unavailable, and unchecked coverage", () => {
  const agents = [
    agent,
    { ...agent, id: "missing", name: "Missing Mac" },
    { ...agent, id: "blocked", name: "Blocked Mac" },
    {
      ...agent,
      id: "offline",
      name: "Offline Mac",
      eligible: false,
      reason: "Agent is offline",
    },
    { ...agent, id: "unknown", name: "Unchecked Mac" },
  ];
  render(
    <TransferDestinationEditor
      agents={agents}
      repositories={[repository]}
      destinations={[]}
      coverage={[
        existing,
        { ...existing, agentId: "missing", status: "READY" },
        {
          ...existing,
          agentId: "blocked",
          status: "BLOCKED",
          error: "Destination is occupied",
        },
        {
          ...existing,
          agentId: "offline",
          status: "BLOCKED",
          error: "Agent is offline",
        },
      ]}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getAllByText("Missing")).toHaveLength(1);
  expect(screen.getByText("Needs attention")).toBeDefined();
  expect(screen.getByText("Unavailable")).toBeDefined();
  expect(screen.getByText("Not checked")).toBeDefined();
  expect(screen.getByText("Destination is occupied")).toBeDefined();
  const selectors = screen.getAllByRole("checkbox", {
    name: "Select missing repositories on this agent",
  });
  expect((selectors[0] as HTMLButtonElement).disabled).toBe(true);
  expect((selectors[1] as HTMLButtonElement).disabled).toBe(false);
  expect((selectors[3] as HTMLButtonElement).disabled).toBe(true);
});

test.each(["Import to this agent", "Mobile"])(
  "the import label %s only changes its editor while Sync is mounted",
  (label) => {
    const syncChanged = vi.fn();
    const importChanged = vi.fn();
    function Harness({
      allowExisting = false,
      onChange,
    }: {
      allowExisting?: boolean;
      onChange: (values: TransferDestinationInput[]) => void;
    }) {
      const [destinations, setDestinations] = useState<
        TransferDestinationInput[]
      >([]);
      return (
        <TransferDestinationEditor
          allowExisting={allowExisting}
          agents={[agent]}
          repositories={[repository]}
          destinations={destinations}
          coverage={[{ ...existing, status: "READY" }]}
          onChange={(values) => {
            setDestinations(values);
            onChange(values);
          }}
        />
      );
    }
    render(
      <>
        <section aria-label="Background Sync">
          <Harness onChange={syncChanged} />
        </section>
        <div role="dialog" aria-label="Import package">
          <Harness allowExisting onChange={importChanged} />
        </div>
      </>,
    );
    const sync = within(
      screen.getByRole("region", { name: "Background Sync" }),
    );
    const dialog = within(
      screen.getByRole("dialog", { name: "Import package" }),
    );

    fireEvent.click(dialog.getByText(label, { selector: "label" }));

    expect(syncChanged).not.toHaveBeenCalled();
    expect(importChanged).toHaveBeenLastCalledWith([
      {
        repositoryKey: repository.key,
        agentId: agent.id,
        relativePath: "mobile",
        remoteUrl: existing.remoteUrl,
      },
    ]);

    fireEvent.click(
      sync.getByText("Select missing repositories on this agent", {
        selector: "label",
      }),
    );
    for (const editor of [sync, dialog]) {
      for (const name of ["Folder relative to base directory", "Clone URL"]) {
        const fieldLabel = editor.getByText(name, {
          selector: "label",
        }) as HTMLLabelElement;
        expect(fieldLabel.control).toBe(editor.getByRole("textbox", { name }));
      }
    }
    fireEvent.change(
      dialog.getByLabelText("Folder relative to base directory"),
      {
        target: { value: "imported/mobile" },
      },
    );
    expect(syncChanged).toHaveBeenCalledTimes(1);
    expect(importChanged).toHaveBeenLastCalledWith([
      expect.objectContaining({ relativePath: "imported/mobile" }),
    ]);
  },
);
