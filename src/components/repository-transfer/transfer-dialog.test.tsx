import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { downloadJson } from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { RepositoryTransferDialog } from "./transfer-dialog";
import type { TransferItem, TransferPreview } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => () => undefined),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => undefined }),
}));
vi.mock("@/lib/browser-utils", async (original) => ({
  ...(await original<typeof import("@/lib/browser-utils")>()),
  downloadJson: vi.fn(),
}));
const request = vi.mocked(controlPlaneRequest);
const repository: TransferItem = {
  key: "repository:one",
  parentKey: null,
  kind: "REPOSITORY",
  label: "Mobile app",
  repositoryKey: "repository:one",
  selected: true,
  dependency: false,
  action: "IMPORT",
  targetId: "local-repository",
  candidates: [],
  current: { name: "Old name" },
  incoming: {
    name: "Mobile app",
    canonicalOrigin: "github.com/acme/mobile",
    remoteUrl: "git@github.com:acme/mobile.git",
  },
  affectedRepositories: [],
  warnings: [],
};
const description: TransferItem = {
  ...repository,
  key: "repository:one:description",
  parentKey: repository.key,
  kind: "SETTING",
  label: "Repository description",
  current: "Local description",
  incoming: "Imported description",
};
const workflow: TransferItem = {
  ...repository,
  key: "workflow:one",
  parentKey: null,
  kind: "WORKFLOW",
  label: "Build workflow",
  current: null,
  targetId: null,
  incoming: { name: "Build workflow" },
};
const preview: TransferPreview = {
  fingerprint: "review-1",
  items: [repository, description, workflow],
  dependencies: [],
  agents: [
    {
      id: "agent-1",
      name: "Build Mac",
      eligible: true,
      baseRepoDirectory: "/Repos",
      reason: null,
    },
  ],
  destinations: [],
  blockers: [],
  warnings: [],
};

beforeEach(() => {
  request.mockReset();
  vi.mocked(downloadJson).mockReset();
});
afterEach(cleanup);

function upload() {
  const file = new File(["{}"], "mobile.repository.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "text", {
    value: async () => JSON.stringify({ format: "test-package" }),
  });
  fireEvent.change(screen.getByLabelText("JSON package"), {
    target: { files: [file] },
  });
}

test("changing a reviewed import invalidates confirmation and preserves selections in the next preview", async () => {
  const operation = {
    id: "operation-1",
    requestId: "request-1",
    kind: "IMPORT",
    status: "SUCCEEDED",
    appId: null,
    result: {},
    items: [],
    createdAt: "",
    updatedAt: "",
  };
  request.mockImplementation(async (query) => {
    if (query.includes("query PreviewRepositoryTransfer"))
      return { previewRepositoryTransfer: preview } as never;
    if (query.includes("mutation ApplyRepositoryTransfer"))
      return { applyRepositoryTransfer: operation } as never;
    if (query.includes("query RepositoryTransferOperation"))
      return { repositoryTransferOperation: operation } as never;
    throw new Error(`Unexpected operation ${query}`);
  });
  render(
    <RepositoryTransferDialog
      direction="import"
      repositoryId="destination"
      onClose={vi.fn()}
    />,
  );
  upload();
  const apply = await screen.findByRole("button", { name: "Import selected" });
  await waitFor(() =>
    expect((apply as HTMLButtonElement).disabled).toBe(false),
  );
  expect(request.mock.calls.some(([query]) => query.includes("mutation"))).toBe(
    false,
  );
  expect(
    screen
      .getByRole("checkbox", { name: "Enable this workflow after import" })
      .getAttribute("data-state"),
  ).toBe("unchecked");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Repository description" }),
  );
  expect((apply as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Review import" }));
  await waitFor(() =>
    expect((apply as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(apply);
  expect(await screen.findByText("Transfer progress")).toBeDefined();
  const call = request.mock.calls.find(([query]) =>
    query.includes("mutation ApplyRepositoryTransfer"),
  );
  expect(call?.[1]).toMatchObject({
    fingerprint: "review-1",
    input: {
      targetRepositoryId: "destination",
      excludedKeys: [description.key],
      enableWorkflowKeys: [],
    },
  });
});

test("exports only the selected contents after an explicit download", async () => {
  const optionalRepository: TransferItem = {
    ...repository,
    key: "repository:optional",
    label: "Optional repository",
    selected: false,
    dependency: true,
  };
  const optionalName: TransferItem = {
    ...optionalRepository,
    key: "repository:optional/field/name",
    parentKey: optionalRepository.key,
    kind: "SETTING",
    label: "name",
  };
  request.mockImplementation(async (query) => {
    if (query.includes("query RepositoryTransferExportPreview"))
      return {
        repositoryTransferExportPreview: {
          payload: {},
          items: [repository, description, optionalRepository, optionalName],
          warnings: [],
        },
      } as never;
    if (query.includes("query ExportRepositoryTransfer"))
      return { exportRepositoryTransfer: { selected: true } } as never;
    throw new Error(`Unexpected operation ${query}`);
  });
  render(
    <RepositoryTransferDialog
      direction="export"
      repositoryId="repository-1"
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Repository description" }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Optional repository" }),
  );
  expect(
    screen
      .getByRole("checkbox", { name: "Repository name" })
      .getAttribute("data-state"),
  ).toBe("checked");
  expect(downloadJson).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
  await waitFor(() =>
    expect(downloadJson).toHaveBeenCalledWith(
      { selected: true },
      "mobile-app.repository.json",
    ),
  );
  expect(
    request.mock.calls.find(([query]) =>
      query.includes("query ExportRepositoryTransfer"),
    )?.[1],
  ).toEqual({
    input: {
      scope: "REPOSITORY",
      id: "repository-1",
      excludedKeys: [description.key],
      includedKeys: [optionalRepository.key],
    },
  });
});

test("keeping an existing workflow clears its import activation opt-in", async () => {
  const existingWorkflow = {
    ...workflow,
    current: { name: "Build workflow" },
    targetId: "existing-workflow",
  };
  request.mockResolvedValue({
    previewRepositoryTransfer: {
      ...preview,
      items: [repository, existingWorkflow],
    },
  } as never);
  render(
    <RepositoryTransferDialog
      direction="import"
      repositoryId="destination"
      onClose={vi.fn()}
    />,
  );
  upload();
  fireEvent.click(
    await screen.findByRole("checkbox", {
      name: "Enable this workflow after import",
    }),
  );
  const choices = screen.getAllByRole("combobox", {
    name: "When this item exists",
  });
  fireEvent.change(choices.at(-1)!, { target: { value: "KEEP" } });
  expect(
    screen.queryByRole("checkbox", {
      name: "Enable this workflow after import",
    }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review import" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    input: {
      enableWorkflowKeys: [],
      choices: [{ key: workflow.key, action: "KEEP" }],
    },
  });
});

test("unresolved dependencies block confirmation and destination choices use agent base directories", async () => {
  request.mockResolvedValue({
    previewRepositoryTransfer: {
      ...preview,
      blockers: ["Map the signing workflow first"],
    },
  } as never);
  render(<RepositoryTransferDialog direction="import" onClose={vi.fn()} />);
  upload();
  expect(
    await screen.findByText("Map the signing workflow first"),
  ).toBeDefined();
  expect(
    (
      screen.getByRole("button", {
        name: "Import selected",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Select missing repositories on this agent",
    }),
  );
  expect(
    (
      screen.getByLabelText(
        "Folder relative to base directory",
      ) as HTMLInputElement
    ).value,
  ).toBe("mobile");
  expect(screen.getByText("/Repos/mobile")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Folder relative to base directory"), {
    target: { value: "apps/mobile" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review import" }));
  await waitFor(() =>
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      input: {
        destinations: [
          {
            repositoryKey: repository.key,
            agentId: "agent-1",
            relativePath: "apps/mobile",
            remoteUrl: "git@github.com:acme/mobile.git",
          },
        ],
      },
    }),
  );
});
