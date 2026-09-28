"use client";

import { Download, FileJson, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { FileDropZone } from "@/components/common/file-drop-zone";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  createClientId,
  downloadJson,
  exportFileStem,
} from "@/lib/browser-utils";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { TransferDestinationEditor } from "./destination-editor";
import { TransferOperationStatus } from "./operation-status";
import { isTransferItemSelected, setTransferItemSelected } from "./selection";
import { TransferSelectionTree } from "./selection-tree";
import {
  isRepositoryItem,
  TRANSFER_ITEM_FIELDS,
  TRANSFER_OPERATION_FIELDS,
  TRANSFER_PREVIEW_FIELDS,
  type TransferExportPreview,
  type TransferInput,
  type TransferItem,
  type TransferOperation,
  type TransferPreview,
} from "./types";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const AUTOMATIC_MAPPING = "__automatic__";

export function RepositoryTransferDialog({
  direction,
  appId,
  repositoryId,
  onClose,
  onImported,
}: {
  direction: "import" | "export";
  appId?: string;
  repositoryId?: string;
  onClose: () => void;
  onImported?: () => void | Promise<void>;
}) {
  const t = useTranslations("repositoryTransfer");
  const [exportPreview, setExportPreview] =
    useState<TransferExportPreview | null>(null);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [input, setInput] = useState<TransferInput>({
    payload: null,
    excludedKeys: [],
    includedKeys: [],
    choices: [],
    mappings: [],
    destinations: [],
    enableWorkflowKeys: [],
    ...(repositoryId ? { targetRepositoryId: repositoryId } : {}),
  });
  const [fileName, setFileName] = useState("");
  const [reviewedInput, setReviewedInput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<TransferOperation | null>(null);
  const inputRef = useRef(input);
  const requestSequence = useRef(0);
  const applyRequestId = useRef<string | null>(null);
  const initialExportInput = {
    scope: repositoryId ? "REPOSITORY" : "APP",
    id: repositoryId ?? appId,
  };
  const scope = initialExportInput.scope;
  const scopeId = initialExportInput.id;
  const update = (change: Partial<TransferInput>) => {
    requestSequence.current += 1;
    applyRequestId.current = null;
    setInput((current) => {
      const next = { ...current, ...change };
      inputRef.current = next;
      return next;
    });
    setReviewedInput(null);
    setError(null);
  };

  useEffect(() => {
    if (direction !== "export" || !scopeId) return;
    const controller = new AbortController();
    void controlPlaneRequest<{
      repositoryTransferExportPreview: TransferExportPreview;
    }>(
      `query RepositoryTransferExportPreview($input: RepositoryTransferExportInput!) { repositoryTransferExportPreview(input: $input) { payload items { ${TRANSFER_ITEM_FIELDS} } warnings } }`,
      { input: { scope, id: scopeId } },
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setExportPreview(data.repositoryTransferExportPreview);
      })
      .catch((value: unknown) => {
        if (!controller.signal.aborted)
          setError(value instanceof Error ? value.message : String(value));
      });
    return () => controller.abort();
  }, [direction, scope, scopeId]);
  useEffect(
    () => () => {
      requestSequence.current += 1;
    },
    [],
  );

  const review = useCallback(async (value: TransferInput) => {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setError(null);
    setReviewedInput(null);
    try {
      const data = await controlPlaneRequest<{
        previewRepositoryTransfer: TransferPreview;
      }>(
        `query PreviewRepositoryTransfer($input: RepositoryTransferImportInput!) { previewRepositoryTransfer(input: $input) { ${TRANSFER_PREVIEW_FIELDS} } }`,
        { input: value },
      );
      if (requestSequence.current !== sequence) return;
      setPreview(data.previewRepositoryTransfer);
      setReviewedInput(JSON.stringify(value));
    } catch (value) {
      if (requestSequence.current === sequence)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (requestSequence.current === sequence) setBusy(false);
    }
  }, []);

  const readFiles = async (files: File[]) => {
    if (busy || !files.length) return;
    const sequence = ++requestSequence.current;
    const emptyInput: TransferInput = {
      payload: null,
      excludedKeys: [],
      includedKeys: [],
      choices: [],
      mappings: [],
      destinations: [],
      enableWorkflowKeys: [],
      ...(repositoryId ? { targetRepositoryId: repositoryId } : {}),
    };
    setBusy(true);
    setError(null);
    setPreview(null);
    setReviewedInput(null);
    setFileName("");
    setInput(emptyInput);
    inputRef.current = emptyInput;
    applyRequestId.current = null;
    try {
      if (files.length !== 1) throw new Error(t("singlePackage"));
      const file = files[0];
      if (file.size > MAX_FILE_BYTES) throw new Error(t("fileTooLarge"));
      const payload: unknown = JSON.parse(await file.text());
      if (requestSequence.current !== sequence) return;
      const next: TransferInput = { ...emptyInput, payload };
      setFileName(file.name);
      setInput(next);
      inputRef.current = next;
      applyRequestId.current = null;
      await review(next);
    } catch (value) {
      if (requestSequence.current === sequence)
        setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (requestSequence.current === sequence) setBusy(false);
    }
  };

  const rawItems =
    direction === "export"
      ? (exportPreview?.items ?? [])
      : (preview?.items ?? []);
  const allRepositories = rawItems.filter(isRepositoryItem);
  const sourceKey =
    input.sourceRepositoryKey ??
    allRepositories.find((item) => !item.dependency)?.key;
  const items =
    repositoryId && direction === "import"
      ? rawItems
          .filter((item) => item.kind !== "APP")
          .map((item) =>
            isRepositoryItem(item) && item.key !== sourceKey
              ? {
                  ...item,
                  dependency: true,
                  selected: input.includedKeys.includes(item.key),
                }
              : item,
          )
      : rawItems;
  const parents = new Map(items.map((item) => [item.key, item.parentKey]));
  const isSelected = (item: TransferItem) =>
    isTransferItemSelected(item.key, input.excludedKeys, parents) &&
    (!item.dependency ||
      input.includedKeys.includes(item.key) ||
      item.selected);
  const repositories = items.filter(
    (item) => isRepositoryItem(item) && isSelected(item),
  );
  const toggle = (item: TransferItem, selected: boolean) => {
    const excludedKeys = setTransferItemSelected(
      item.key,
      selected,
      input.excludedKeys,
    );
    const includedKeys = item.dependency
      ? selected
        ? [...new Set([...input.includedKeys, item.key])]
        : input.includedKeys.filter((key) => key !== item.key)
      : input.includedKeys;
    update({
      excludedKeys,
      includedKeys,
      destinations: input.destinations.filter((destination) =>
        isTransferItemSelected(
          destination.repositoryKey,
          excludedKeys,
          parents,
        ),
      ),
      enableWorkflowKeys: input.enableWorkflowKeys.filter((key) =>
        isTransferItemSelected(key, excludedKeys, parents),
      ),
    });
  };
  const isFresh =
    reviewedInput !== null && reviewedInput === JSON.stringify(input);
  const exportFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        exportRepositoryTransfer: unknown;
      }>(
        `query ExportRepositoryTransfer($input: RepositoryTransferExportInput!) { exportRepositoryTransfer(input: $input) }`,
        {
          input: {
            scope,
            id: scopeId,
            excludedKeys: input.excludedKeys,
            includedKeys: input.includedKeys,
          },
        },
      );
      const label =
        items.find((item) => item.parentKey === null)?.label ?? "settings";
      downloadJson(
        data.exportRepositoryTransfer,
        `${exportFileStem(label)}.${repositoryId ? "repository" : "app"}.json`,
      );
      onClose();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || !isFresh || preview.blockers.length) return;
    setBusy(true);
    setError(null);
    applyRequestId.current ??= createClientId();
    try {
      const data = await controlPlaneRequest<{
        applyRepositoryTransfer: TransferOperation;
      }>(
        `mutation ApplyRepositoryTransfer($input: RepositoryTransferImportInput!, $fingerprint: String!, $requestId: ID!) { applyRepositoryTransfer(input: $input, fingerprint: $fingerprint, requestId: $requestId) { ${TRANSFER_OPERATION_FIELDS} } }`,
        {
          input,
          fingerprint: preview.fingerprint,
          requestId: applyRequestId.current,
        },
      );
      setOperation(data.applyRepositoryTransfer);
      await onImported?.();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      // A changed server snapshot requires review; uncertain network results can
      // safely repeat this same request ID without applying settings twice.
      if (
        value instanceof Error &&
        /stale|fingerprint|preview.*changed/i.test(value.message)
      )
        setReviewedInput(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {t(direction === "export" ? "exportTitle" : "importTitle")}
          </DialogTitle>
          <DialogDescription>
            {t(
              direction === "export"
                ? "exportDescription"
                : repositoryId
                  ? "templateDescription"
                  : "importDescription",
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {operation ? (
          <TransferOperationStatus initial={operation} />
        ) : (
          <>
            {direction === "import" && (
              <Field>
                <FieldLabel htmlFor="repository-transfer-file">
                  {t("packageFile")}
                </FieldLabel>
                <FileDropZone
                  id="repository-transfer-file"
                  aria-label={t("packageFile")}
                  aria-describedby="repository-transfer-file-hint"
                  accept="application/json,.json"
                  className="min-h-32 flex-col p-4 text-center"
                  disabled={busy}
                  multiple={false}
                  onFiles={readFiles}
                >
                  {busy ? (
                    <Spinner className="size-6" />
                  ) : (
                    <Upload className="size-6" aria-hidden="true" />
                  )}
                  <span className="font-medium">{t("dropPackage")}</span>
                  <span id="repository-transfer-file-hint" className="text-xs">
                    {t("packageFileHint")}
                  </span>
                </FileDropZone>
                {fileName && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <FileJson className="size-4" />
                    {fileName}
                  </p>
                )}
              </Field>
            )}
            {direction === "export" && !exportPreview && !error && (
              <p className="flex items-center gap-2">
                <Spinner />
                {t("loading")}
              </p>
            )}
            {(exportPreview?.warnings ?? preview?.warnings ?? []).map(
              (warning, index) => (
                <Alert key={index}>
                  <AlertDescription>{warning}</AlertDescription>
                </Alert>
              ),
            )}
            {repositoryId &&
              direction === "import" &&
              allRepositories.length > 1 && (
                <Field>
                  <FieldLabel htmlFor="transfer-template-source">
                    {t("templateSource")}
                  </FieldLabel>
                  <Select
                    value={sourceKey ?? ""}
                    disabled={busy}
                    onValueChange={(value) =>
                      update({
                        sourceRepositoryKey: value,
                        destinations: [],
                      })
                    }
                  >
                    <SelectTrigger
                      id="transfer-template-source"
                      className="w-full"
                    >
                      <SelectValue placeholder={t("chooseRepository")} />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {allRepositories.map((item) => (
                        <SelectItem value={item.key} key={item.key}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            {items.length > 0 && (
              <section className="space-y-3">
                <h3 className="font-semibold">{t("selectContents")}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("selectionDescription")}
                </p>
                <TransferSelectionTree
                  items={items}
                  excludedKeys={input.excludedKeys}
                  includedKeys={input.includedKeys}
                  onToggle={toggle}
                  readOnly={busy}
                  {...(direction === "import"
                    ? {
                        choices: input.choices,
                        onChoice: (choice) =>
                          update({
                            choices: [
                              ...input.choices.filter(
                                (value) => value.key !== choice.key,
                              ),
                              choice,
                            ],
                            enableWorkflowKeys:
                              choice.action === "KEEP"
                                ? input.enableWorkflowKeys.filter(
                                    (key) => key !== choice.key,
                                  )
                                : input.enableWorkflowKeys,
                          }),
                        enableWorkflowKeys: input.enableWorkflowKeys,
                        onEnableWorkflow: (key, enabled) =>
                          update({
                            enableWorkflowKeys: enabled
                              ? [...new Set([...input.enableWorkflowKeys, key])]
                              : input.enableWorkflowKeys.filter(
                                  (value) => value !== key,
                                ),
                          }),
                      }
                    : {})}
                />
              </section>
            )}
            {direction === "import" && preview && (
              <>
                {preview.dependencies.length > 0 && (
                  <section className="space-y-3">
                    <h3 className="font-semibold">{t("dependencies")}</h3>
                    <p className="text-sm text-muted-foreground">
                      {t("dependenciesDescription")}
                    </p>
                    {preview.dependencies.map((dependency) => (
                      <Field
                        className="rounded-lg border p-3"
                        key={dependency.key}
                      >
                        <FieldLabel htmlFor={`mapping-${dependency.key}`}>
                          {dependency.label}
                        </FieldLabel>
                        <Select
                          disabled={busy}
                          value={
                            input.mappings.find(
                              (mapping) => mapping.key === dependency.key,
                            )?.targetId ??
                            dependency.targetId ??
                            AUTOMATIC_MAPPING
                          }
                          onValueChange={(value) =>
                            update({
                              mappings: [
                                ...input.mappings.filter(
                                  (mapping) => mapping.key !== dependency.key,
                                ),
                                ...(value !== AUTOMATIC_MAPPING
                                  ? [
                                      {
                                        key: dependency.key,
                                        targetId: value,
                                      },
                                    ]
                                  : []),
                              ],
                            })
                          }
                        >
                          <SelectTrigger
                            id={`mapping-${dependency.key}`}
                            className="w-full"
                          >
                            <SelectValue placeholder={t("chooseMapping")} />
                          </SelectTrigger>
                          <SelectContent position="popper">
                            <SelectItem value={AUTOMATIC_MAPPING}>
                              {t("chooseMapping")}
                            </SelectItem>
                            {dependency.candidates.map((candidate) => (
                              <SelectItem
                                key={candidate.id}
                                value={candidate.id}
                              >
                                {candidate.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {!dependency.resolved && (
                          <p className="text-sm text-amber-700 dark:text-amber-300">
                            {t("unresolvedDependency")}
                          </p>
                        )}
                      </Field>
                    ))}
                  </section>
                )}
                {repositories.length > 0 && (
                  <section className="space-y-3">
                    <h3 className="font-semibold">
                      {t(repositoryId ? "optionalClones" : "destinationAgents")}
                    </h3>
                    <TransferDestinationEditor
                      allowExisting
                      agents={preview.agents}
                      repositories={repositories}
                      destinations={input.destinations}
                      coverage={preview.destinations}
                      onChange={(destinations) => update({ destinations })}
                      disabled={busy}
                    />
                  </section>
                )}
                {preview.blockers.length > 0 && (
                  <Alert variant="destructive">
                    <AlertDescription>
                      <p className="font-medium">{t("resolveBlockers")}</p>
                      <ul className="mt-2 list-disc space-y-1 pl-4">
                        {preview.blockers.map((blocker, index) => (
                          <li key={index}>{blocker}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}
                {!isFresh && (
                  <Alert>
                    <AlertDescription>{t("reviewAgain")}</AlertDescription>
                  </Alert>
                )}
                {isFresh && preview.blockers.length === 0 && (
                  <Alert>
                    <AlertDescription>{t("readyToImport")}</AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </>
        )}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            {t(operation ? "close" : "cancel")}
          </Button>
          {!operation && direction === "export" && (
            <Button
              disabled={busy || !exportPreview || !items.some(isSelected)}
              onClick={() => void exportFile()}
            >
              {busy ? <Spinner /> : <Download />}
              {t("download")}
            </Button>
          )}
          {!operation && direction === "import" && input.payload !== null && (
            <>
              <Button
                disabled={busy}
                onClick={() => void review(inputRef.current)}
                variant="outline"
              >
                {busy && <Spinner />}
                {t("reviewImport")}
              </Button>
              <Button
                disabled={
                  busy || !isFresh || !preview || preview.blockers.length > 0
                }
                onClick={() => void apply()}
              >
                <Upload />
                {t("applyImport")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
